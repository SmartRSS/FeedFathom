import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const ORIGIN = "https://feedfathom.test";
const source = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();

type FetchEvent = {
  request: Request;
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
};

type Callback = (() => void) | undefined;

// The slice of IndexedDB the mutation queue uses: one auto-increment store,
// with every request settling on a later microtask as the real API does.
const fakeIndexedDb = () => {
  const rows = new Map<number, unknown>();
  let nextKey = 1;
  let opens = 0;
  const transaction = () => {
    const tx: { oncomplete: Callback } = { oncomplete: undefined };
    const complete = () => queueMicrotask(() => tx.oncomplete?.());
    const objectStore = () => ({
      add: (value: unknown) => {
        rows.set(nextKey++, value);
        complete();
      },
      delete: (key: number) => {
        rows.delete(key);
        complete();
      },
      openCursor: () => {
        const request: { onsuccess: Callback; result: unknown } = {
          onsuccess: undefined,
          result: null,
        };
        const keys = [...rows.keys()];
        const step = (index: number) => {
          const key = keys[index];
          request.result =
            key === undefined
              ? null
              : {
                  continue: () => queueMicrotask(() => step(index + 1)),
                  key,
                  value: rows.get(key),
                };
          request.onsuccess?.();
        };
        queueMicrotask(() => step(0));
        return request;
      },
    });
    return Object.assign(tx, { objectStore });
  };
  return {
    indexedDB: {
      open: () => {
        opens++;
        const request: { onsuccess: Callback; result: unknown } = {
          onsuccess: undefined,
          result: { close: () => {}, transaction },
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
    opens: () => opens,
    rows,
  };
};

// Lets the fire-and-forget work a handler starts after responding, such as
// the queue flush and the article cache trim, run to completion.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Runs public/sw.js against an in-memory Cache API, a counting fetch and an
// in-memory IndexedDB, and hands back its fetch listener.
const loadServiceWorker = (
  network: (path: string, method: string) => Response | Promise<Response>,
) => {
  let onFetch: ((event: FetchEvent) => void) | undefined;
  // Map order stands in for the Cache API's insertion order; put deletes
  // first so a replaced entry moves to the end, as it does there.
  const entries = new Map<string, Response>();
  const key = (request: Request | string) => {
    const url = new URL(
      typeof request === "string" ? request : request.url,
      ORIGIN,
    );
    return url.pathname + url.search;
  };
  const cache = {
    delete: async (request: Request | string) => entries.delete(key(request)),
    keys: async () =>
      [...entries.keys()].map((path) => new Request(ORIGIN + path)),
    match: async (request: Request | string) =>
      entries.get(key(request))?.clone(),
    put: async (request: Request | string, response: Response) => {
      entries.delete(key(request));
      entries.set(key(request), response);
    },
  };
  const queue = fakeIndexedDb();
  const requests: string[] = [];
  const messages: unknown[] = [];
  runInNewContext(source, {
    Headers,
    Response,
    URL,
    btoa,
    caches: { open: async () => cache },
    fetch: async (input: Request | string, init?: RequestInit) => {
      const path = key(input);
      const method =
        init?.method ?? (typeof input === "string" ? "GET" : input.method);
      requests.push(method === "GET" ? path : `${method} ${path}`);
      return network(path, method);
    },
    indexedDB: queue.indexedDB,
    self: {
      addEventListener: (
        type: string,
        listener: (event: FetchEvent) => void,
      ) => {
        if (type === "fetch") onFetch = listener;
      },
      clients: {
        matchAll: async () => [
          { postMessage: (message: unknown) => messages.push(message) },
        ],
      },
      location: { origin: ORIGIN },
      registration: {},
    },
  });
  // `background` settles once the response has and every promise the handler
  // handed to waitUntil by then has too, such as a shell revalidation.
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
    const response = handled ?? Promise.reject(new Error("not handled"));
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
  return {
    dispatch,
    entries,
    loadArticle,
    loadTree,
    messages,
    navigate,
    queue,
    requests,
  };
};

// The ?v= fingerprint (tree.ts) is what makes the URL content-addressed: the
// same path always decodes to the same bytes, so the SW never needs to
// re-ask once a path is cached.
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

test("a cached favicon is inlined as a data URL, and a warm tree reload fetches none", async () => {
  const sw = loadServiceWorker(network);
  await Promise.all(
    tree.tree.map(
      (node) => sw.dispatch(new Request(`${ORIGIN}${node.favicon}`)).response,
    ),
  );
  expect(await sw.loadTree()).toEqual({
    tree: [
      { favicon: "data:image/png;base64,aWNvbg==", type: "source" },
      { favicon: "data:image/png;base64,aWNvbg==", type: "source" },
    ],
  });
  const before = sw.requests.length;
  await sw.loadTree();
  expect(
    sw.requests
      .slice(before)
      .filter((path) => path.startsWith("/api/favicon/")),
  ).toHaveLength(0);
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
  online = false; // lie-fi: requests hang instead of failing
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
  expect(sw.entries.has("/assets/index-new.js")).toBe(true);
  expect(await sw.entries.get("/")?.clone().text()).toBe(
    shellHtml("index-new"),
  );
});

test("a cached shell missing one of its assets waits for the network", async () => {
  const sw = loadServiceWorker(shellNetwork("index-new"));
  sw.entries.set("/", new Response(shellHtml("index-gone")));
  const response = await sw.navigate("/").response;
  expect(await response.text()).toBe(shellHtml("index-new"));
});

const articleNetwork = (path: string) =>
  Response.json({ path, servedAt: performance.now() });

test("a just-prefetched article opens without a network round trip", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const prefetched = await sw.loadArticle(2);
  expect(await sw.loadArticle(2)).toEqual(prefetched);
  expect(sw.requests).toEqual(["/api/article?article=2"]);
});

test("an article cached over a minute ago goes to the network first", async () => {
  const sw = loadServiceWorker(articleNetwork);
  const prefetched = await sw.loadArticle(2);
  sw.entries.set(
    "/api/article?article=2",
    Response.json(prefetched, {
      headers: { "X-SW-Fetched-At": String(Date.now() - 61_000) },
    }),
  );
  expect(await sw.loadArticle(2)).not.toEqual(prefetched);
  expect(sw.requests).toEqual([
    "/api/article?article=2",
    "/api/article?article=2",
  ]);
});

test("opening 300 articles keeps only the newest 200 cached", async () => {
  const sw = loadServiceWorker(articleNetwork);
  await sw.loadTree();
  for (let id = 1; id <= 300; id++) {
    // oxlint-disable-next-line no-await-in-loop -- articles open one by one
    await sw.loadArticle(id);
  }
  await settle();
  const articles = [...sw.entries.keys()].filter((path) =>
    path.startsWith("/api/article?"),
  );
  expect(articles).toHaveLength(200);
  expect(articles[0]).toBe("/api/article?article=101");
  expect(sw.entries.has("/api/tree")).toBe(true);
});

test("an empty mutation queue is read once, not on every response", async () => {
  const sw = loadServiceWorker(articleNetwork);
  for (let id = 1; id <= 5; id++) {
    // oxlint-disable-next-line no-await-in-loop -- articles open one by one
    await sw.loadArticle(id);
    // oxlint-disable-next-line no-await-in-loop -- let each flush finish
    await settle();
  }
  expect(sw.queue.opens()).toBe(1);
});

test("a deletion queued offline replays on the next successful request", async () => {
  let online = true;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    return method === "GET" ? articleNetwork(path) : new Response(null);
  });
  await sw.loadArticle(1);
  await settle();
  online = false;
  const removal = sw.dispatch(
    new Request(`${ORIGIN}/api/articles`, {
      body: JSON.stringify({ removedArticleIdList: [7] }),
      method: "DELETE",
    }),
  );
  expect(await (await removal.response).json()).toEqual([7]);
  online = true;
  await sw.loadArticle(2);
  await settle();
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/articles",
    "DELETE /api/articles",
  ]);
  expect(sw.queue.rows.size).toBe(0);
});

// index.html gates its /api/tree preload on the same route list, so the page
// and the worker agree on which navigations fetch the tree early (#938).
test("index.html and sw.js exclude the same routes from the tree preload", async () => {
  const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
  const swList = /TREE_PRELOAD_EXCLUDED_PATHS =\s*(\/.+\/);/.exec(source)?.[1];
  const htmlList = /!(\/.+\/)\.test\(/.exec(html)?.[1];
  expect(swList).toBeDefined();
  expect(htmlList).toBe(swList);
});
