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
const loadServiceWorker = (network: (path: string) => Response) => {
  let onFetch: ((event: FetchEvent) => void) | undefined;
  const entries = new Map<string, Response>();
  const key = (request: Request | string) =>
    new URL(typeof request === "string" ? request : request.url, ORIGIN)
      .pathname;
  const cache = {
    match: async (request: Request | string) =>
      entries.get(key(request))?.clone(),
    put: async (request: Request | string, response: Response) => {
      entries.set(key(request), response);
    },
  };
  const requests: string[] = [];
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
      location: { origin: ORIGIN },
    },
  });
  const loadTree = async () => {
    let response: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    onFetch?.({
      request: new Request(`${ORIGIN}/api/tree`),
      respondWith: (promise) => {
        response = promise;
      },
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    const body: unknown = await (await response)?.json();
    await Promise.all(pending);
    return body;
  };
  return { loadTree, requests };
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
