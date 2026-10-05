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
    // One store stands in for every named cache, so deleting any of them
    // empties it.
    caches: {
      delete: async () => {
        entries.clear();
        return true;
      },
      open: async () => cache,
    },
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
    // An unhandled request goes to the network untouched, as in a browser.
    const response =
      handled ?? Promise.resolve(network(key(request), request.method));
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

test("a cached tree request answers from the cache alone, and a miss is a 504", async () => {
  const sw = loadServiceWorker(network);
  const cachedTree = () =>
    sw.dispatch(new Request(`${ORIGIN}/api/tree?cached`)).response;
  expect((await cachedTree()).status).toBe(504);
  expect(sw.requests).toEqual([]);

  await sw.dispatch(new Request(`${ORIGIN}${tree.tree[0]?.favicon}`)).response;
  await sw.loadTree();
  const before = sw.requests.length;
  expect(await (await cachedTree()).json()).toEqual({
    tree: [
      { favicon: "data:image/png;base64,aWNvbg==", type: "source" },
      { favicon: "/api/favicon/2?v=def", type: "source" },
    ],
  });
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
  expect(sw.requests.filter((path) => path.startsWith("/api/article"))).toEqual(
    ["/api/article?article=2"],
  );
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
  await sw.dispatch(
    new Request(`${ORIGIN}/api/login`, { body: "{}", method: "POST" }),
  ).response;
  expect(await sw.loadArticle(2)).toMatchObject({ account: "b" });
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

// GET /api/session as the given account, or signed out with null.
const session = (id: number | null) =>
  Response.json({ user: id === null ? null : { id } });

test("an empty mutation queue is read once, not on every response", async () => {
  const sw = loadServiceWorker((path) =>
    path === "/api/session" ? session(1) : articleNetwork(path),
  );
  for (let id = 1; id <= 5; id++) {
    // oxlint-disable-next-line no-await-in-loop -- articles open one by one
    await sw.loadArticle(id);
    // oxlint-disable-next-line no-await-in-loop -- let each flush finish
    await settle();
  }
  expect(sw.queue.opens()).toBe(1);
});

test("a failed account lookup is retried, so a later offline removal still replays", async () => {
  let online = true;
  let sessionUp = false;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/session")
      return sessionUp ? session(1) : new Response(null, { status: 503 });
    return method === "GET" ? Response.json({ tree: [] }) : new Response(null);
  });
  await sw.loadTree();
  await settle();
  sessionUp = true;
  await sw.loadTree();
  await settle();
  online = false;
  await sw.dispatch(
    new Request(`${ORIGIN}/api/source`, {
      body: JSON.stringify({ removeSourceId: 3 }),
      method: "DELETE",
    }),
  ).response;
  online = true;
  await sw.loadTree();
  await settle();
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/source",
    "DELETE /api/source",
  ]);
  expect(sw.queue.rows.size).toBe(0);
});

// The connection drops after the tree loads but before the first session
// lookup answers.
test("a removal made while the first account lookup is in flight waits for it", async () => {
  let online = true;
  let answerLookup: (() => void) | undefined;
  const sw = loadServiceWorker((path, method) => {
    if (path === "/api/session" && !answerLookup)
      return new Promise<Response>((resolve) => {
        answerLookup = () => resolve(session(1));
      });
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/session") return session(1);
    return method === "GET" ? Response.json({ tree: [] }) : new Response(null);
  });
  await sw.loadTree();
  await settle();
  online = false;
  const removal = sw.dispatch(
    new Request(`${ORIGIN}/api/source`, {
      body: JSON.stringify({ removeSourceId: 3 }),
      method: "DELETE",
    }),
  ).response;
  await settle();
  answerLookup?.();
  expect(await (await removal).json()).toBe(3);
  online = true;
  await sw.loadTree();
  await settle();
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/source",
    "DELETE /api/source",
  ]);
  expect(sw.queue.rows.size).toBe(0);
});

test("a removal with no known account fails offline instead of being queued", async () => {
  let online = true;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/session") return new Response(null, { status: 503 });
    return method === "GET" ? Response.json({ tree: [] }) : new Response(null);
  });
  await sw.loadTree();
  await settle();
  online = false;
  const removal = sw.dispatch(
    new Request(`${ORIGIN}/api/source`, {
      body: JSON.stringify({ removeSourceId: 3 }),
      method: "DELETE",
    }),
  );
  removal.background.catch(() => {});
  await expect(removal.response).rejects.toThrow("Failed to fetch");
  await settle();
  expect(sw.queue.rows.size).toBe(0);
});

// Account 1's session lookup is still in flight when the account changes;
// returns the account recorded once that lookup finally answers.
const recordAfterOvertakenLookup = async (
  change: "/api/login" | "/api/logout",
  nextAccount: number | null,
) => {
  let account: number | null = 1;
  let answerFirstLookup: (() => void) | undefined;
  const sw = loadServiceWorker((path) => {
    if (path === "/api/session") {
      const response = session(account);
      if (answerFirstLookup) return response;
      return new Promise<Response>((resolve) => {
        answerFirstLookup = () => resolve(response);
      });
    }
    if (path === change) {
      account = nextAccount;
      return Response.json({ success: true });
    }
    return Response.json({ tree: [] });
  });
  await sw.loadTree();
  await settle();
  await sw.dispatch(new Request(`${ORIGIN}${change}`, { method: "POST" }))
    .response;
  await sw.loadTree();
  await settle();
  answerFirstLookup?.();
  await settle();
  const record: unknown = await sw.entries.get("/sw-queue-account")?.json();
  return record;
};

test("a session lookup overtaken by a sign-in doesn't record the previous account", async () => {
  expect(await recordAfterOvertakenLookup("/api/login", 2)).toEqual({ id: 2 });
});

test("a session lookup overtaken by a logout doesn't record the previous account", async () => {
  expect(await recordAfterOvertakenLookup("/api/logout", null)).toBeUndefined();
});

// The removal is in flight when account 2 signs in from another tab, and
// fails after that sign-in completes.
test("a removal that fails after another account signs in stays account 1's", async () => {
  let account = 1;
  let failRemoval: (() => void) | undefined;
  const sw = loadServiceWorker((path, method) => {
    if (path === "/api/session") return session(account);
    if (path === "/api/login") {
      account = 2;
      return Response.json({ sid: "s" });
    }
    if (method === "DELETE" && !failRemoval)
      return new Promise<Response>((_resolve, reject) => {
        failRemoval = () => reject(new TypeError("Failed to fetch"));
      });
    return method === "GET" ? Response.json({ tree: [] }) : new Response(null);
  });
  await sw.loadTree();
  await settle();
  const removal = sw.dispatch(
    new Request(`${ORIGIN}/api/source`, {
      body: JSON.stringify({ removeSourceId: 3 }),
      method: "DELETE",
    }),
  ).response;
  await settle();
  await sw.dispatch(
    new Request(`${ORIGIN}/api/login`, { body: "{}", method: "POST" }),
  ).response;
  await sw.loadTree();
  await settle();
  failRemoval?.();
  await removal;
  await sw.loadTree();
  await settle();
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/source",
  ]);
  expect(sw.queue.rows.size).toBe(0);
});

// The page's own /api/session request is cached like any other, and answers
// signed out once the session has expired.
test("a signed-out session answer doesn't erase the owner of later offline removals", async () => {
  let online = true;
  let account: number | null = 1;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/session") return session(account);
    if (path === "/api/login") {
      account = 1;
      return Response.json({ sid: "s" });
    }
    return method === "GET" ? Response.json({ tree: [] }) : new Response(null);
  });
  await sw.loadTree();
  await settle();
  account = null;
  await sw.dispatch(new Request(`${ORIGIN}/api/session`)).response;
  online = false;
  await sw.dispatch(
    new Request(`${ORIGIN}/api/source`, {
      body: JSON.stringify({ removeSourceId: 3 }),
      method: "DELETE",
    }),
  ).response;
  online = true;
  await sw.dispatch(
    new Request(`${ORIGIN}/api/login`, { body: "{}", method: "POST" }),
  ).response;
  await sw.loadTree();
  await settle();
  expect(sw.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
    "DELETE /api/source",
    "DELETE /api/source",
  ]);
  expect(sw.queue.rows.size).toBe(0);
});

test("a deletion queued offline replays on the next successful request", async () => {
  let online = true;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/session") return session(1);
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

// The server refuses to remove a folder that still holds a source, so a
// folder removal replayed past a failed source removal would be rejected and
// dropped (#975).
test("a removal queued behind a temporarily failing one waits for it", async () => {
  let online = false;
  let sourceRemovalFails = true;
  let sourceExists = true;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/session") return session(1);
    if (method === "GET") return Response.json({ tree: [] });
    if (path === "/api/source") {
      if (sourceRemovalFails) return new Response(null, { status: 503 });
      sourceExists = false;
      return new Response(null);
    }
    return new Response(null, { status: sourceExists ? 400 : 200 });
  });
  const remove = (path: string, body: object) =>
    sw.dispatch(
      new Request(`${ORIGIN}${path}`, {
        body: JSON.stringify(body),
        method: "DELETE",
      }),
    ).response;
  sw.entries.set("/sw-queue-account", Response.json({ id: 1 }));
  await remove("/api/source", { removeSourceId: 1 });
  await remove("/api/folders", { removeFolderId: 2 });
  online = true;
  await sw.loadTree();
  await settle();
  expect(sw.queue.rows.size).toBe(2);
  expect(sw.messages).toEqual([]);
  sourceRemovalFails = false;
  await sw.loadTree();
  await settle();
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

// Account 1 removes a source offline and its session lapses. Whoever signs in
// next decides whether the removal replays (#982).
const removeOfflineThenSignIn = async (nextAccount: number) => {
  let online = true;
  let account: number | null = 1;
  const sw = loadServiceWorker((path, method) => {
    if (!online) throw new TypeError("Failed to fetch");
    if (path === "/api/session") return session(account);
    if (path === "/api/login") {
      account = nextAccount;
      return Response.json({ sid: "s" });
    }
    if (method === "GET") return Response.json({ tree: [] });
    return new Response(null, { status: account === null ? 401 : 200 });
  });
  const deletes = () => sw.requests.filter((path) => path.startsWith("DELETE"));
  await sw.loadTree();
  await settle();
  online = false;
  await sw.dispatch(
    new Request(`${ORIGIN}/api/source`, {
      body: JSON.stringify({ removeSourceId: 3 }),
      method: "DELETE",
    }),
  ).response;
  online = true;
  account = null;
  await sw.loadTree();
  await settle();
  expect(sw.queue.rows.size).toBe(1);
  await sw.dispatch(
    new Request(`${ORIGIN}/api/login`, { body: "{}", method: "POST" }),
  ).response;
  await sw.loadTree();
  await settle();
  return {
    deletes: deletes(),
    messages: sw.messages,
    queued: sw.queue.rows.size,
  };
};

test("a removal queued by one account is dropped, not sent, when another signs in", async () => {
  expect(await removeOfflineThenSignIn(2)).toEqual({
    deletes: ["DELETE /api/source"],
    messages: [],
    queued: 0,
  });
});

test("a removal queued before the session expired replays when the same account signs back in", async () => {
  expect(await removeOfflineThenSignIn(1)).toEqual({
    deletes: ["DELETE /api/source", "DELETE /api/source"],
    messages: [],
    queued: 0,
  });
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
