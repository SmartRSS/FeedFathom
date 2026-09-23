import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

const ORIGIN = "https://feedfathom.test";
const source = await Bun.file(`${import.meta.dir}/../public/sw.js`).text();

type FetchEvent = {
  request: Request;
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
};

// Runs public/sw.js against an in-memory Cache API and a counting fetch, and
// hands back its fetch listener. indexedDB.open never settles, so the queue
// flush that follows each API response stays idle.
const loadServiceWorker = (
  network: (path: string) => Response | Promise<Response>,
) => {
  let onFetch: ((event: FetchEvent) => void) | undefined;
  const entries = new Map<string, Response>();
  const key = (request: Request | string) => {
    const url = new URL(
      typeof request === "string" ? request : request.url,
      ORIGIN,
    );
    return url.pathname + url.search;
  };
  const cache = {
    match: async (request: Request | string) =>
      entries.get(key(request))?.clone(),
    put: async (request: Request | string, response: Response) => {
      entries.set(key(request), response);
    },
  };
  const requests: string[] = [];
  const messages: unknown[] = [];
  runInNewContext(source, {
    Headers,
    Response,
    URL,
    btoa,
    caches: { open: async () => cache },
    fetch: async (input: Request | string) => {
      const path = key(input);
      requests.push(path);
      return network(path);
    },
    indexedDB: { open: () => ({}) },
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
  return { entries, loadArticle, loadTree, messages, navigate, requests };
};

const tree = {
  tree: [
    { favicon: "/api/favicon/1", type: "source" },
    { favicon: "/api/favicon/2", type: "source" },
  ],
};

const network = (path: string) =>
  path === "/api/tree"
    ? Response.json(tree)
    : new Response("icon", { headers: { "Content-Type": "image/png" } });

test("ten tree loads fetch each favicon at most once", async () => {
  const { loadTree, requests } = loadServiceWorker(network);
  for (let load = 0; load < 10; load++) {
    // oxlint-disable-next-line no-await-in-loop -- loads are sequential polls
    await loadTree();
  }
  expect(requests.filter((path) => path === "/api/favicon/1")).toHaveLength(1);
  expect(requests.filter((path) => path === "/api/favicon/2")).toHaveLength(1);
});

test("a cached favicon is inlined as a data URL", async () => {
  const { loadTree } = loadServiceWorker(network);
  await loadTree();
  expect(await loadTree()).toEqual({
    tree: [
      { favicon: "data:image/png;base64,aWNvbg==", type: "source" },
      { favicon: "data:image/png;base64,aWNvbg==", type: "source" },
    ],
  });
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
