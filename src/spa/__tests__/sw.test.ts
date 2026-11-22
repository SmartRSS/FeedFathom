import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { articlePageSize } from "#shared/contracts/limits.ts";
import {
  accountHeader,
  accountMismatchStatus,
} from "#shared/contracts/headers.ts";
import {
  apiCachePrefix,
  offlineArticleLimit,
  offlineArticleMaxAgeDays,
} from "../sw-protocol.ts";

const ORIGIN = "https://feedfathom.test";
const SHELL_CACHE = "shell-v7";
const built = await Bun.build({
  entrypoints: [`${import.meta.dir}/../sw.ts`],
  format: "iife",
  target: "browser",
});
const source = (await built.outputs[0]?.text()) ?? "";

type FetchEvent = {
  request: Request;
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
};

type MessageEvent = {
  data: unknown;
  waitUntil: (promise: Promise<unknown>) => void;
};

type Callback = (() => void) | undefined;

type OfflineRow = {
  id: number;
  publishedAt: string;
  sourceId: number;
  revision: string | null;
};

const offlineRow = (id: number, overrides: Partial<OfflineRow> = {}) => ({
  id,
  publishedAt: new Date().toJSON(),
  revision: null,
  sourceId: 3,
  ...overrides,
});

const firing = (type: string) => {
  const listeners: Callback[] = [];
  queueMicrotask(() => {
    for (const listener of listeners) listener?.();
  });
  return {
    addEventListener: (event: string, listener: Callback) => {
      if (event === type) listeners.push(listener);
    },
  };
};

const fakeIndexedDb = () => {
  const rows = new Map<number, unknown>();
  let nextKey = 1;
  let opens = 0;
  const store = {
    add: (value: unknown) => {
      rows.set(nextKey, value);
      return { result: nextKey++ };
    },
    clear: () => {
      rows.clear();
      return { result: undefined };
    },
    delete: (key: number) => {
      rows.delete(key);
      return { result: undefined };
    },
    getAll: () => ({ result: [...rows.values()] }),
    getAllKeys: () => ({ result: [...rows.keys()] }),
  };
  const transaction = () => ({
    ...firing("complete"),
    objectStore: () => store,
  });
  return {
    indexedDB: {
      open: () => {
        opens++;
        return {
          ...firing("success"),
          result: { close: () => {}, transaction },
        };
      },
    },
    opens: () => opens,
    rows,
  };
};

const loadServiceWorker = (
  network: (
    path: string,
    method: string,
    headers: Headers,
  ) => Response | Promise<Response>,
  stores = new Map<string, Map<string, Response>>(),
) => {
  let onFetch: ((event: FetchEvent) => void) | undefined;
  let onMessage: ((event: MessageEvent) => void) | undefined;
  let onActivate:
    | ((event: { waitUntil: (promise: Promise<unknown>) => void }) => void)
    | undefined;
  const store = (name: string) => {
    const existing = stores.get(name);
    if (existing) return existing;
    const created = new Map<string, Response>();
    stores.set(name, created);
    return created;
  };
  const key = (request: Request | string) => {
    const url = new URL(
      typeof request === "string" ? request : request.url,
      ORIGIN,
    );
    return url.pathname + url.search;
  };
  const cacheOver = (entries: Map<string, Response>) => ({
    delete: async (request: Request | string) => entries.delete(key(request)),
    keys: async () =>
      [...entries.keys()].map((path) => new Request(ORIGIN + path)),
    match: async (request: Request | string) =>
      entries.get(key(request))?.clone(),
    put: async (request: Request | string, response: Response) => {
      entries.delete(key(request));
      entries.set(key(request), response);
    },
  });
  const live = (prefix: string) => {
    const entries = new Map<string, Response>();
    for (const [name, stored] of stores)
      if (name.startsWith(prefix))
        for (const [path, response] of stored) entries.set(path, response);
    return entries;
  };
  const queue = fakeIndexedDb();
  const requests: string[] = [];
  const waiters: { label: string; resolve: () => void }[] = [];
  const requested = (label: string) =>
    new Promise<void>((resolve) => waiters.push({ label, resolve }));
  const messages: unknown[] = [];
  let listed: OfflineRow[] = [];
  const heldListings: Promise<void>[] = [];
  const holdListing = () => {
    let release!: () => void;
    heldListings.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };
  const listArticles = async (body: unknown) => {
    await heldListings.shift();
    const parsed: unknown = typeof body === "string" ? JSON.parse(body) : {};
    const cursor =
      parsed && typeof parsed === "object" && "cursor" in parsed
        ? parsed.cursor
        : undefined;
    const start =
      cursor === undefined
        ? 0
        : listed.findIndex((row) => row.id === cursor) + 1;
    return Response.json(listed.slice(start, start + articlePageSize));
  };
  runInNewContext(source, {
    AbortController,
    Headers,
    Response,
    URL,
    caches: {
      delete: async (name: string) => stores.delete(name),
      keys: async () => [...stores.keys()],
      open: async (name: string) => cacheOver(store(name)),
    },
    crypto,
    fetch: async (input: Request | string, init?: RequestInit) => {
      const path = key(input);
      const method =
        init?.method ?? (typeof input === "string" ? "GET" : input.method);
      const label = method === "GET" ? path : `${method} ${path}`;
      requests.push(label);
      for (const waiter of waiters.splice(0))
        if (waiter.label === label) waiter.resolve();
        else waiters.push(waiter);
      const headers = new Headers(
        init?.headers ?? (typeof input === "string" ? {} : input.headers),
      );
      const answer =
        typeof input === "string" &&
        method === "POST" &&
        path === "/api/articles"
          ? listArticles(init?.body)
          : network(path, method, headers);
      const { signal } = init ?? {};
      if (!signal) return answer;
      const aborted = new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      );
      return Promise.race([answer, aborted]);
    },
    indexedDB: queue.indexedDB,
    self: {
      addEventListener: (
        type: string,
        listener: ((event: FetchEvent) => void) &
          ((event: MessageEvent) => void) &
          ((event: { waitUntil: (promise: Promise<unknown>) => void }) => void),
      ) => {
        if (type === "fetch") onFetch = listener;
        if (type === "message") onMessage = listener;
        if (type === "activate") onActivate = listener;
      },
      clients: {
        claim: async () => {},
        matchAll: async () => [
          {
            postMessage: (message: unknown) => messages.push(message),
            visibilityState: "visible",
          },
        ],
      },
      location: { origin: ORIGIN },
      registration: {},
    },
  });
  const dispatch = (request: Request) => {
    let handled: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    onFetch?.({
      request,
      respondWith: (promise) => {
        handled = promise;
      },
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    const response =
      handled ??
      Promise.resolve(network(key(request), request.method, request.headers));
    const background = response.then(() => Promise.all(pending));
    return { background, response };
  };
  const loadTree = async () => {
    const { background, response } = dispatch(
      new Request(`${ORIGIN}/api/tree`),
    );
    const body: unknown = await (await response).json();
    await background;
    return body;
  };
  const navigate = (path: string) =>
    dispatch(new Request(`${ORIGIN}${path}`, { mode: "navigate" }));
  const loadArticle = async (id: number) => {
    const { background, response } = dispatch(
      new Request(`${ORIGIN}/api/article?article=${id}`),
    );
    const body: unknown = await (await response).json();
    await background;
    return body;
  };
  const post = async (data: unknown) => {
    const pending: Promise<unknown>[] = [];
    onMessage?.({ data, waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  };
  const keepOffline = async (articles: (number | OfflineRow)[]) => {
    listed = articles.map((row) =>
      typeof row === "number" ? offlineRow(row) : row,
    );
    await post({
      sources: articles.length > 0 ? [3] : [],
      type: "offline-sync",
    });
  };
  const liveApiCache = () => {
    const names = [...stores.keys()].filter((name) =>
      name.startsWith(apiCachePrefix),
    );
    const [name] = names;
    if (names.length !== 1 || name === undefined)
      throw new Error(`expected one live API cache, found ${names.join(", ")}`);
    return store(name);
  };
  const login = () =>
    dispatch(new Request(`${ORIGIN}/api/login`, { body: "{}", method: "POST" }))
      .response;
  const removal = (
    path: string,
    body: object,
    account: number | string | null = 1,
  ) =>
    dispatch(
      new Request(`${ORIGIN}${path}`, {
        body: JSON.stringify(body),
        headers: account === null ? {} : { [accountHeader]: String(account) },
        method: "DELETE",
      }),
    );
  const removeSource = (account?: number | string | null) =>
    removal("/api/source", { removeSourceId: 3 }, account);
  const remove = (path: string, body: object) => removal(path, body).response;
  const activate = async () => {
    const pending: Promise<unknown>[] = [];
    onActivate?.({ waitUntil: (promise) => void pending.push(promise) });
    await Promise.all(pending);
  };
  return {
    activate,
    apiBodies: () =>
      Promise.all(
        [...live(apiCachePrefix).values()].map((response) =>
          response.clone().text(),
        ),
      ),
    apiEntries: () => live(apiCachePrefix),
    cacheStorage: stores,
    dispatch,
    holdListing,
    keepOffline,
    loadArticle,
    loadTree,
    login,
    messages,
    navigate,
    post,
    queue,
    remove,
    removeSource,
    requested,
    requests,
    seed: (name: string, path: string, response: Response) =>
      store(name).set(path, response),
    seedApi: (path: string, response: Response) =>
      liveApiCache().set(path, response),
    shellEntries: () => live("shell-"),
  };
};

const tree = {
  tree: [
    { favicon: "/api/favicon/1?v=abc", type: "source" },
    { favicon: "/api/favicon/2?v=def", type: "source" },
  ],
};

const network = (path: string) =>
  path === "/api/tree"
    ? Response.json(tree)
    : new Response("icon", { headers: { "Content-Type": "image/png" } });

test("a favicon is fetched once and then served from the cache", async () => {
  const sw = loadServiceWorker(network);
  const load = () =>
    sw.dispatch(new Request(`${ORIGIN}/api/favicon/1?v=abc`)).response;
  for (let attempt = 0; attempt < 3; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- repeated img loads of the same icon
    await load();
  }
  expect(
    sw.requests.filter((path) => path === "/api/favicon/1?v=abc"),
  ).toHaveLength(1);
});

test("activation drops the v7 cache", async () => {
  const stored = new Map([
    [
      `${apiCachePrefix}v7`,
      new Map([
        ["/api/favicon/1?v=old", new Response("icon")],
        ["/sw-offline-article?article=1", new Response("body")],
      ]),
    ],
  ]);
  const sw = loadServiceWorker(network, stored);
  await sw.activate();
  expect([...stored.keys()]).not.toContain(`${apiCachePrefix}v7`);
  expect([...sw.apiEntries().keys()]).toEqual([]);
});

test("a restarted worker keeps the API cache it was using", async () => {
  let online = true;
  const offlineAware = (path: string) => {
    if (!online) throw new TypeError("Failed to fetch");
    return articleNetwork(path);
  };
  const sw = loadServiceWorker(offlineAware);
  await sw.keepOffline([2]);
  const restarted = loadServiceWorker(offlineAware, sw.cacheStorage);
  online = false;
  expect(await restarted.loadArticle(2)).toMatchObject({
    path: "/api/article?article=2",
  });
  expect(restarted.requests).toEqual([]);
});

test("a cached tree request answers from the cache alone, and a miss is a 504", async () => {
  const sw = loadServiceWorker(network);
  const cachedTree = () =>
    sw.dispatch(new Request(`${ORIGIN}/api/tree?cached`)).response;
  expect((await cachedTree()).status).toBe(504);
  expect(sw.requests).toEqual([]);

  await sw.loadTree();
  const before = sw.requests.length;
  expect(await (await cachedTree()).json()).toEqual(tree);
  expect(sw.requests.slice(before)).toEqual([]);
});

const shellHtml = (bundle: string) =>
  `<script type="module" src="/assets/${bundle}.js"></script>`;

const shellNetwork =
  (bundle: string) =>
  (path: string): Response =>
    path === "/"
      ? new Response(shellHtml(bundle), {
          headers: { "Content-Type": "text/html" },
        })
      : path === "/api/tree"
        ? Response.json({ tree: [] })
        : new Response("asset");

test("a warm launch serves the cached shell without waiting for the network", async () => {
  let online = true;
  const sw = loadServiceWorker((path) =>
    online ? shellNetwork("index-old")(path) : new Promise<Response>(() => {}),
  );
  await sw.navigate("/").background;
  online = false;
  const response = await sw.navigate("/").response;
  expect(await response.text()).toBe(shellHtml("index-old"));
});

test("a revalidated shell with a new bundle is cached with its assets and announced", async () => {
  let bundle = "index-old";
  const sw = loadServiceWorker((path) => shellNetwork(bundle)(path));
  await sw.navigate("/").background;
  expect(sw.messages).toEqual([]);
  bundle = "index-new";
  const { background, response } = sw.navigate("/");
  expect(await (await response).text()).toBe(shellHtml("index-old"));
  await background;
  expect(sw.messages).toEqual([{ type: "shell-updated" }]);
  expect(sw.shellEntries().has("/assets/index-new.js")).toBe(true);
  expect(await sw.shellEntries().get("/")?.clone().text()).toBe(
    shellHtml("index-new"),
  );
});

test("a cached shell missing one of its assets waits for the network", async () => {
  const sw = loadServiceWorker(shellNetwork("index-new"));
  sw.seed(SHELL_CACHE, "/", new Response(shellHtml("index-gone")));
  const response = await sw.navigate("/").response;
  expect(await response.text()).toBe(shellHtml("index-new"));
});

test("a tree preloaded before a sign-in is not served after it", async () => {
  let account = "a";
  const sw = loadServiceWorker((path) => {
    if (path === "/api/login") {
      account = "b";
      return Response.json({ sid: "s" });
    }
    return path === "/api/tree"
      ? Response.json({ account, tree: [] })
      : shellNetwork("index")(path);
  });
  await sw.navigate("/").background;
  await sw.login();
  expect(await sw.loadTree()).toEqual({ account: "b", tree: [] });
  expect((await sw.apiBodies()).join("\n")).not.toContain('"account":"a"');
});

test("a deploy's assets, lazy chunks included, are dropped once a newer shell is served", async () => {
  let bundle = "old";
  const sw = loadServiceWorker((path) => {
    if (path === "/") return new Response(shellHtml(`index-${bundle}`));
    if (path.startsWith("/assets/index-"))
      return new Response(`m(["assets/options-${bundle}.js"])`);
    return path === "/api/tree"
      ? Response.json({ tree: [] })
      : new Response("asset");
  });
  const assets = () =>
    [...sw.shellEntries().keys()].filter((key) => key.startsWith("/assets/"));
  await sw.navigate("/").background;
  await sw.dispatch(new Request(`${ORIGIN}/assets/options-old.js`)).response;
  bundle = "new";
  await sw.navigate("/").background;
  await sw.dispatch(new Request(`${ORIGIN}/assets/options-new.js`)).response;
  expect(assets()).toHaveLength(4);
  await sw.navigate("/").background;
  expect(assets().toSorted()).toEqual([
    "/assets/index-new.js",
    "/assets/options-new.js",
  ]);
  expect(await sw.shellEntries().get("/")?.text()).toBe(shellHtml("index-new"));
});

test("a font the served stylesheet names is kept", async () => {
  let bundle = "old";
  const sw = loadServiceWorker((path) => {
    if (path === "/")
      return new Response(
        `<link rel="stylesheet" href="/assets/index-${bundle}.css">`,
      );
    if (path.startsWith("/assets/index-"))
      return new Response(`@font-face{src:url(/assets/font-${bundle}.woff2)}`);
    return path === "/api/tree"
      ? Response.json({ tree: [] })
      : new Response("asset");
  });
  const assets = () =>
    [...sw.shellEntries().keys()].filter((key) => key.startsWith("/assets/"));
  await sw.navigate("/").background;
  await sw.dispatch(new Request(`${ORIGIN}/assets/font-old.woff2`)).response;
  bundle = "new";
  await sw.navigate("/").background;
  await sw.dispatch(new Request(`${ORIGIN}/assets/font-new.woff2`)).response;
  await sw.navigate("/").background;
  expect(assets().toSorted()).toEqual([
    "/assets/font-new.woff2",
    "/assets/index-new.css",
  ]);
});

test("a tree load drops the favicons it no longer names", async () => {
  let current = tree;
  const sw = loadServiceWorker((path) =>
    path === "/api/tree" ? Response.json(current) : network(path),
  );
  await sw.loadTree();
  await Promise.all(
    tree.tree.map(
      (node) => sw.dispatch(new Request(`${ORIGIN}${node.favicon}`)).response,
    ),
  );
  sw.seedApi("/sw-offline-article?article=1", new Response("body"));
  current = { tree: [{ favicon: "/api/favicon/2?v=new", type: "source" }] };
  await sw.loadTree();
  await sw.dispatch(new Request(`${ORIGIN}/api/favicon/2?v=new`)).response;
  expect(
    [...sw.apiEntries().keys()].filter((key) =>
      key.startsWith("/api/favicon/"),
    ),
  ).toEqual(["/api/favicon/2?v=new"]);
  expect(sw.apiEntries().has("/sw-offline-article?article=1")).toBe(true);
});

test("each API path keeps only its 20 newest query strings", async () => {
  const sw = loadServiceWorker(articleNetwork);
  for (let id = 1; id <= 30; id++) {
    // oxlint-disable-next-line no-await-in-loop -- lookups made one by one
    await sw.dispatch(new Request(`${ORIGIN}/api/find?url=${id}`)).background;
  }
  const finds = [...sw.apiEntries().keys()].filter((key) =>
    key.startsWith("/api/find?"),
  );
  expect(finds).toHaveLength(20);
  expect(finds[0]).toBe("/api/find?url=11");
});

const articleNetwork = (path: string) =>
  Response.json({ path, servedAt: performance.now() });

test("a just-prefetched article opens without a network round trip", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const prefetched = await sw.loadArticle(2);
  expect(await sw.loadArticle(2)).toEqual(prefetched);
  expect(sw.requests.filter((path) => path.startsWith("/api/article"))).toEqual(
    ["/api/article?article=2"],
  );
});

test("an article cached over a minute ago goes to the network first", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const prefetched = await sw.loadArticle(2);
  sw.seedApi(
    "/api/article?article=2",
    Response.json(prefetched, {
      headers: { "X-SW-Fetched-At": String(Date.now() - 61_000) },
    }),
  );
  expect(await sw.loadArticle(2)).not.toEqual(prefetched);
  expect(sw.requests.filter((path) => path.startsWith("/api/article"))).toEqual(
    ["/api/article?article=2", "/api/article?article=2"],
  );
});

test("signing in drops articles cached under the previous account", async () => {
  let account = "a";
  const sw = loadServiceWorker((path, method) =>
    method === "POST"
      ? Response.json({ sid: account })
      : Response.json({ account, path }),
  );
  expect(await sw.loadArticle(2)).toMatchObject({ account: "a" });
  account = "b";
  await sw.login();
  expect(await sw.loadArticle(2)).toMatchObject({ account: "b" });
  expect((await sw.apiBodies()).join("\n")).not.toContain('"account":"a"');
});

test("an account change made outside the worker drops what it cached", async () => {
  const sw = loadServiceWorker(articleNetwork);
  await sw.loadArticle(2);
  await sw.loadTree();
  await sw.post({ type: "account-changed" });
  expect([...sw.apiEntries().keys()]).toEqual([]);
  const cachedTree = await sw.dispatch(new Request(`${ORIGIN}/api/tree?cached`))
    .response;
  expect(cachedTree.status).toBe(504);
});

test("a response in flight when account-changed arrives is not stored", async () => {
  let answer: (() => void) | undefined;
  const sw = loadServiceWorker((path) => {
    if (path !== "/api/article?article=2") return articleNetwork(path);
    return new Promise<Response>((resolve) => {
      answer = () => resolve(Response.json({ account: "a", path }));
    });
  });
  const requested = sw.requested("/api/article?article=2");
  const inFlight = sw.loadArticle(2);
  await requested;
  await sw.post({ type: "account-changed" });
  answer?.();
  await inFlight;
  expect([...sw.apiEntries().keys()]).toEqual([]);
  await sw.loadArticle(3);
  expect([...sw.apiEntries().keys()]).toEqual(["/api/article?article=3"]);
});

test("opening 300 articles keeps only the newest 200 cached", async () => {
  const sw = loadServiceWorker(articleNetwork);
  await sw.loadTree();
  for (let id = 1; id <= 300; id++) {
    // oxlint-disable-next-line no-await-in-loop -- articles open one by one
    await sw.loadArticle(id);
  }
  const articles = [...sw.apiEntries().keys()].filter((path) =>
    path.startsWith("/api/article?"),
  );
  expect(articles).toHaveLength(200);
  expect(articles[0]).toBe("/api/article?article=101");
  expect(sw.apiEntries().has("/api/tree")).toBe(true);
});

const articleRequests = (requests: string[]) =>
  requests.filter((path) => path.startsWith("/api/article?"));

const storedBodies = (entries: Map<string, Response>) =>
  [...entries.keys()]
    .filter((path) => path.startsWith("/sw-offline-article?"))
    .toSorted();

test("a downloaded article opens offline with no network request, past the trim", async () => {
  let online = true;
  const sw = loadServiceWorker((path) => {
    if (!online) throw new TypeError("Failed to fetch");
    return articleNetwork(path);
  });
  await sw.keepOffline([2]);
  for (let id = 100; id < 400; id++) {
    // oxlint-disable-next-line no-await-in-loop -- articles open one by one
    await sw.loadArticle(id);
  }
  online = false;
  sw.requests.length = 0;
  expect(await sw.loadArticle(2)).toMatchObject({
    path: "/api/article?article=2",
  });
  expect(sw.requests).toEqual([]);
});

test("a sync downloads only what is missing and drops what is no longer listed", async () => {
  const sw = loadServiceWorker(articleNetwork);
  await sw.keepOffline([1, 2]);
  await sw.keepOffline([2, 3]);
  expect(articleRequests(sw.requests)).toEqual([
    "/api/article?article=1",
    "/api/article?article=2",
    "/api/article?article=3",
  ]);
  expect(storedBodies(sw.apiEntries())).toEqual([
    "/sw-offline-article?article=2",
    "/sw-offline-article?article=3",
  ]);
  await sw.keepOffline([]);
  expect([...sw.apiEntries().keys()]).toEqual([]);
});

test("a body is fetched again once the feed rewrites its article", async () => {
  const sw = loadServiceWorker(articleNetwork);
  await sw.keepOffline([2, 3]);
  await sw.keepOffline([
    2,
    offlineRow(3, { revision: "2026-10-06T10:00:00.000Z" }),
  ]);
  expect(articleRequests(sw.requests)).toEqual([
    "/api/article?article=2",
    "/api/article?article=3",
    "/api/article?article=3",
  ]);
});

test("an outdated body stays readable when its replacement fails", async () => {
  let failing = false;
  const sw = loadServiceWorker((path) =>
    failing ? new Response(null, { status: 503 }) : articleNetwork(path),
  );
  await sw.keepOffline([2]);
  failing = true;
  await sw.keepOffline([offlineRow(2, { revision: new Date().toJSON() })]);
  expect(storedBodies(sw.apiEntries())).toEqual([
    "/sw-offline-article?article=2",
  ]);
});

test("rows posted before a sign-in are dropped, even queued behind a download", async () => {
  let answer: (() => void) | undefined;
  const sw = loadServiceWorker((path, method) => {
    if (method === "POST") return Response.json({ sid: "s" });
    return new Promise<Response>((resolve) => {
      answer = () => resolve(articleNetwork(path));
    });
  });
  const downloading = sw.requested("/api/article?article=2");
  const first = sw.keepOffline([2]);
  await downloading;
  const queued = sw.keepOffline([3]);
  await sw.login();
  answer?.();
  await Promise.all([first, queued]);
  expect([...sw.apiEntries().keys()]).toEqual([]);
});

test("rows listed before a sign-in are dropped when they answer after it", async () => {
  const sw = loadServiceWorker((path, method) =>
    method === "POST" ? Response.json({ sid: "s" }) : articleNetwork(path),
  );
  const release = sw.holdListing();
  const listing = sw.requested("POST /api/articles");
  const sync = sw.keepOffline([2]);
  await listing;
  await sw.login();
  release();
  await sync;
  expect([...sw.apiEntries().keys()]).toEqual([]);
  expect(articleRequests(sw.requests)).toEqual([]);
});

test("a listing in flight when the option goes off can't undo it", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const release = sw.holdListing();
  const listing = sw.requested("POST /api/articles");
  const inFlight = sw.keepOffline([2]);
  await listing;
  await sw.keepOffline([]);
  release();
  await inFlight;
  expect([...sw.apiEntries().keys()]).toEqual([]);
});

test("a newer sync's rows win over an older listing still in flight", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const release = sw.holdListing();
  const listing = sw.requested("POST /api/articles");
  const older = sw.keepOffline([1]);
  await listing;
  await sw.keepOffline([1, 2]);
  release();
  await older;
  expect(storedBodies(sw.apiEntries())).toEqual([
    "/sw-offline-article?article=1",
    "/sw-offline-article?article=2",
  ]);
});

const listings = (requests: string[]) =>
  requests.filter((request) => request === "POST /api/articles");

test("a sync keeps the newest unread rows up to the limit, none past the age limit", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const listed = offlineArticleLimit + articlePageSize / 2;
  await sw.keepOffline(
    Array.from({ length: listed }, (_, index) => listed - index),
  );
  expect(listings(sw.requests)).toHaveLength(
    Math.ceil(offlineArticleLimit / articlePageSize),
  );
  const kept = storedBodies(sw.apiEntries());
  expect(kept).toHaveLength(offlineArticleLimit);
  expect(kept).toContain(`/sw-offline-article?article=${listed}`);
  expect(kept).not.toContain(
    `/sw-offline-article?article=${listed - offlineArticleLimit}`,
  );

  sw.requests.length = 0;
  const stale = new Date(
    Date.now() - (offlineArticleMaxAgeDays + 1) * 24 * 60 * 60 * 1000,
  ).toJSON();
  await sw.keepOffline([2, 1, offlineRow(3, { publishedAt: stale }), 4]);
  expect(listings(sw.requests)).toHaveLength(1);
  expect(storedBodies(sw.apiEntries())).toEqual([
    "/sw-offline-article?article=1",
    "/sw-offline-article?article=2",
  ]);
});

test("switching off clears at once, even behind a stalled download", async () => {
  let stall = false;
  const sw = loadServiceWorker((path, method) => {
    if (stall && method === "GET") return new Promise<Response>(() => {});
    return method === "POST" ? Response.json([]) : articleNetwork(path);
  });
  await sw.keepOffline([1]);
  stall = true;
  const stalled = sw.requested("/api/article?article=3");
  void sw.keepOffline([1, 3]);
  await stalled;
  await sw.keepOffline([]);
  expect([...sw.apiEntries().keys()]).toEqual([]);
});

test("an older sync can't prune what a newer one keeps", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const older = sw.keepOffline([1]);
  await sw.keepOffline([1, 2]);
  await older;
  expect(storedBodies(sw.apiEntries())).toEqual([
    "/sw-offline-article?article=1",
    "/sw-offline-article?article=2",
  ]);
});

test("offline, the unread list comes from the kept rows, scoped like the server", async () => {
  let online = true;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/tree")
      return Response.json({
        tree: [
          {
            children: [{ type: "source", uid: "4" }],
            type: "folder",
            uid: "7",
          },
          { type: "source", uid: "3" },
        ],
      });
    if (path === "/api/article?article=4")
      return new Response(null, { status: 404 });
    return method === "POST" ? Response.json([]) : articleNetwork(path);
  });
  await sw.loadTree();
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toJSON();
  await sw.keepOffline([
    offlineRow(1),
    offlineRow(2, { publishedAt: old }),
    offlineRow(3, { sourceId: 4 }),
    offlineRow(5),
    offlineRow(4),
  ]);
  online = false;
  await sw.remove("/api/articles", { removedArticleIdList: [5] });
  const list = async (body: object, headers: Record<string, string> = {}) => {
    const { background, response } = sw.dispatch(
      new Request(`${ORIGIN}/api/articles`, {
        body: JSON.stringify(body),
        headers,
        method: "POST",
      }),
    );
    background.catch(() => {});
    const rows: { id: number }[] = await (await response).json();
    return rows.map((row) => row.id);
  };
  expect(await list({ filter: "unread", sources: [3] })).toEqual([1, 2]);
  expect(await list({ folder: 7, sources: [] })).toEqual([3]);
  expect(await list({ sources: [], view: "today" })).toEqual([1, 3]);
  expect(await list({ cursor: 1, sources: [3] })).toEqual([2]);
  expect(await list({ cursor: 99, sources: [3] })).toEqual([]);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toJSON();
  expect(
    await list(
      { cursor: 99, sources: [3] },
      { "X-Cursor-Published-At": dayAgo },
    ),
  ).toEqual([2]);
  online = true;
  const millisecond = new Date().toJSON().slice(0, -1);
  await sw.keepOffline([
    offlineRow(100, { publishedAt: `${millisecond}900Z` }),
    offlineRow(200, { publishedAt: `${millisecond}500Z` }),
  ]);
  online = false;
  expect(await list({ cursor: 100, sources: [3] })).toEqual([200]);
  await expect(list({ filter: "read", sources: [3] })).rejects.toThrow();
});

test("a download answered after a sign-in is not stored", async () => {
  let answer: (() => void) | undefined;
  const sw = loadServiceWorker((path, method) => {
    if (method === "POST") return Response.json({ sid: "s" });
    return new Promise<Response>((resolve) => {
      answer = () => resolve(articleNetwork(path));
    });
  });
  const downloading = sw.requested("/api/article?article=2");
  const sync = sw.keepOffline([2]);
  await downloading;
  await sw.login();
  answer?.();
  await sync;
  expect([...sw.apiEntries().keys()]).toEqual([]);
  expect(articleRequests(sw.requests)).toEqual(["/api/article?article=2"]);
});

const removalAs = (
  signedIn: number | null,
  headers: Headers,
  applied: number[],
) => {
  if (signedIn === null) return new Response(null, { status: 401 });
  const named = headers.get(accountHeader);
  if (named !== null && named !== String(signedIn))
    return new Response(null, { status: accountMismatchStatus });
  applied.push(signedIn);
  return new Response(null);
};

test("an empty mutation queue is read once, not on every response", async () => {
  const sw = loadServiceWorker(articleNetwork);
  for (let id = 1; id <= 5; id++) {
    // oxlint-disable-next-line no-await-in-loop -- articles open one by one
    await sw.loadArticle(id);
  }
  expect(sw.queue.opens()).toBe(1);
});

test("a removal that names no account fails offline instead of being queued", async () => {
  let online = true;
  const sw = loadServiceWorker((_path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    return method === "GET" ? Response.json({ tree: [] }) : new Response(null);
  });
  await sw.loadTree();
  online = false;
  const removal = sw.removeSource(null);
  removal.background.catch(() => {});
  await expect(removal.response).rejects.toThrow("Failed to fetch");
  expect(sw.queue.rows.size).toBe(0);
});

test.each(["007", "7.0"])(
  "a removal that names account %p, a form no account id takes, fails offline instead of being queued",
  async (named) => {
    let online = true;
    const sw = loadServiceWorker((_path, method) => {
      if (!online) throw new TypeError("Failed to fetch");
      return method === "GET"
        ? Response.json({ tree: [] })
        : new Response(null);
    });
    await sw.loadTree();
    online = false;
    const removal = sw.removeSource(named);
    removal.background.catch(() => {});
    await expect(removal.response).rejects.toThrow("Failed to fetch");
    expect(sw.queue.rows.size).toBe(0);
  },
);

test("a removal replayed just after another tab signs in to another account is not applied to it", async () => {
  let online = true;
  let signedIn = 1;
  let otherTabSignsIn = false;
  const applied: number[] = [];
  const sw = loadServiceWorker((_path, method, headers) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (method === "GET") return Response.json({ tree: [] });
    if (otherTabSignsIn) signedIn = 2;
    return removalAs(signedIn, headers, applied);
  });
  await sw.loadTree();
  online = false;
  await sw.removeSource().response;
  online = true;
  otherTabSignsIn = true;
  await sw.loadTree();
  expect(applied).toEqual([]);
  expect(sw.queue.rows.size).toBe(0);
  expect(sw.messages).toEqual([]);
});

test("a removal that fails after another account signs in stays account 1's", async () => {
  let signedIn = 1;
  let failRemoval: (() => void) | undefined;
  const applied: number[] = [];
  const sw = loadServiceWorker((path, method, headers) => {
    if (path === "/api/login") {
      signedIn = 2;
      return Response.json({ sid: "s" });
    }
    if (method === "GET") return Response.json({ tree: [] });
    if (!failRemoval)
      return new Promise<Response>((_resolve, reject) => {
        failRemoval = () => reject(new TypeError("Failed to fetch"));
      });
    return removalAs(signedIn, headers, applied);
  });
  await sw.loadTree();
  const sent = sw.requested("DELETE /api/source");
  const removal = sw.removeSource().response;
  await sent;
  await sw.login();
  await sw.loadTree();
  failRemoval?.();
  await removal;
  await sw.loadTree();
  expect(applied).toEqual([]);
  expect(sw.queue.rows.size).toBe(0);
  expect(sw.messages).toEqual([]);
});

test("a deletion queued offline replays on the next successful request", async () => {
  let online = true;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    return method === "GET" ? articleNetwork(path) : new Response(null);
  });
  await sw.loadArticle(1);
  online = false;
  const removal = sw.dispatch(
    new Request(`${ORIGIN}/api/articles`, {
      body: JSON.stringify({ removedArticleIdList: [7] }),
      headers: { [accountHeader]: "1" },
      method: "DELETE",
    }),
  );
  expect(await (await removal.response).json()).toEqual([7]);
  online = true;
  await sw.loadArticle(2);
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/articles",
    "DELETE /api/articles",
  ]);
  expect(sw.queue.rows.size).toBe(0);
});

test("a replayed deletion carries its account and original trace, and says it is a replay", async () => {
  let online = true;
  const deletes: Headers[] = [];
  const sw = loadServiceWorker((path, method, headers) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (method === "DELETE") deletes.push(headers);
    return method === "GET" ? articleNetwork(path) : new Response(null);
  });
  await sw.loadArticle(1);
  online = false;
  const removal = sw.dispatch(
    new Request(`${ORIGIN}/api/articles`, {
      body: JSON.stringify({ removedArticleIdList: [7] }),
      headers: {
        "X-FeedFathom-Trace": '{"trigger":{"type":"click"}}',
        [accountHeader]: "1",
      },
      method: "DELETE",
    }),
  );
  await removal.response;
  online = true;
  await sw.loadArticle(2);
  const replay = deletes.at(-1);
  expect(replay?.get(accountHeader)).toBe("1");
  expect(replay?.get("X-FeedFathom-Trace")).toBe(
    '{"trigger":{"type":"click"}}',
  );
  expect(Number(replay?.get("X-FeedFathom-Replay"))).toBeGreaterThan(0);
});

test.each([
  [403, true],
  [404, true],
  [409, true],
  [401, false],
])(
  "a replay answered %p is dropped and reported: %p",
  async (status, final) => {
    let online = true;
    const sw = loadServiceWorker((path, method) => {
      if (!online) throw new TypeError("Failed to fetch");
      if (method === "GET") return articleNetwork(path);
      return path === "/api/source"
        ? new Response(null, { status })
        : new Response(null);
    });
    await sw.loadArticle(1);
    online = false;
    await sw.remove("/api/source", { removeSourceId: 1 });
    await sw.remove("/api/articles", { removedArticleIdList: [7] });
    online = true;
    await sw.loadArticle(2);

    expect(sw.messages).toEqual(
      final ? [{ type: "queued-mutation-failed" }] : [],
    );
    expect(sw.queue.rows.size).toBe(final ? 0 : 2);
  },
);

test("a removal queued behind a temporarily failing one waits for it", async () => {
  let online = false;
  let sourceRemovalFails = true;
  let sourceExists = true;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (method === "GET") return Response.json({ tree: [] });
    if (path === "/api/source") {
      if (sourceRemovalFails) return new Response(null, { status: 503 });
      sourceExists = false;
      return new Response(null);
    }
    return new Response(null, { status: sourceExists ? 400 : 200 });
  });
  await sw.remove("/api/source", { removeSourceId: 1 });
  await sw.remove("/api/folders", { removeFolderId: 2 });
  online = true;
  await sw.loadTree();
  expect(sw.queue.rows.size).toBe(2);
  expect(sw.messages).toEqual([]);
  sourceRemovalFails = false;
  await sw.loadTree();
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/source",
    "DELETE /api/folders",
    "DELETE /api/source",
    "DELETE /api/source",
    "DELETE /api/folders",
  ]);
  expect(sw.queue.rows.size).toBe(0);
  expect(sw.messages).toEqual([]);
});

test("a flush that starts during another doesn't replay its entries twice", async () => {
  let online = false;
  let foldersDown = true;
  let answerSource: (() => void) | undefined;
  const sw = loadServiceWorker((path, method) => {
    if (method === "GET") return Response.json({ tree: [] });
    if (!online || (path === "/api/folders" && foldersDown))
      throw new TypeError("Failed to fetch");
    if (path === "/api/source" && !answerSource)
      return new Promise<Response>((resolve) => {
        answerSource = () => resolve(new Response(null));
      });
    return new Response(null);
  });
  await sw.remove("/api/source", { removeSourceId: 1 });
  online = true;
  const replay = sw.requested("DELETE /api/source");
  const firstLoad = sw.dispatch(new Request(`${ORIGIN}/api/tree`));
  await replay;
  await sw.remove("/api/folders", { removeFolderId: 2 });
  foldersDown = false;
  const secondLoad = sw.dispatch(new Request(`${ORIGIN}/api/tree`));
  await secondLoad.response;
  answerSource?.();
  await Promise.all([firstLoad.background, secondLoad.background]);
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/source",
    "DELETE /api/source",
    "DELETE /api/folders",
    "DELETE /api/folders",
  ]);
  expect(sw.queue.rows.size).toBe(0);
});

const removeOfflineThenSignIn = async (nextAccount: number) => {
  let online = true;
  let signedIn: number | null = 1;
  const applied: number[] = [];
  const sw = loadServiceWorker((path, method, headers) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/login") {
      signedIn = nextAccount;
      return Response.json({ sid: "s" });
    }
    if (method === "GET") return Response.json({ tree: [] });
    return removalAs(signedIn, headers, applied);
  });
  await sw.loadTree();
  online = false;
  await sw.removeSource().response;
  online = true;
  signedIn = null;
  await sw.loadTree();
  expect(sw.queue.rows.size).toBe(1);
  await sw.login();
  await sw.loadTree();
  return { applied, messages: sw.messages, queued: sw.queue.rows.size };
};

test("a removal queued by one account is refused, not applied, when another signs in", async () => {
  expect(await removeOfflineThenSignIn(2)).toEqual({
    applied: [],
    messages: [],
    queued: 0,
  });
});

test("a removal queued before the session expired replays when the same account signs back in", async () => {
  expect(await removeOfflineThenSignIn(1)).toEqual({
    applied: [1],
    messages: [],
    queued: 0,
  });
});

test("logging out drops the removals waiting to replay, and the API cache", async () => {
  let online = true;
  const sw = loadServiceWorker((path) => {
    if (path === "/api/logout") return Response.json({ success: true });
    if (!online) return Promise.reject(new TypeError("Failed to fetch"));
    return Response.json({ tree: [] });
  });
  await sw.loadTree();
  online = false;
  await sw.removeSource().response;
  expect(sw.queue.rows.size).toBe(1);
  expect([...sw.apiEntries().keys()]).toEqual(["/api/tree"]);
  await sw.dispatch(new Request(`${ORIGIN}/api/logout`, { method: "POST" }))
    .response;
  expect(sw.queue.rows.size).toBe(0);
  expect([...sw.apiEntries().keys()]).toEqual([]);
});

test("the event stream passes through the worker untouched", async () => {
  const sw = loadServiceWorker(
    () =>
      new Response(": connected\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  await sw.dispatch(new Request(`${ORIGIN}/api/events`)).background;
  expect(sw.requests).toEqual([]);
  expect([...sw.apiEntries().keys()]).toEqual([]);
});
