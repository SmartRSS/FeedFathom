import { expect, test } from "bun:test";
import {
  type Dependencies,
  sessionUser,
  createDependencies,
  appFor,
  send,
  get,
  post,
} from "../../../__tests__/server-harness.ts";

test("validates admin sort and URL policies before service calls", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.authenticate = async () => ({
    ...sessionUser,
    isAdmin: true,
  });
  const sorts: [string, "asc" | "desc"][] = [];
  let updates = 0;
  dependencies.sourcesDataService.listAllSources = async (sortBy, order) => {
    sorts.push([sortBy, order]);
    return [];
  };
  dependencies.sourcesDataService.updateSourceUrl = async () => {
    updates++;
    return "updated";
  };
  const app = await appFor(dependencies);
  const cookie = { cookie: "sid=admin" };

  const validSort = await get(
    app,
    "/api/admin?sortBy=subscriberCount&order=desc",
    { headers: cookie },
  );
  const invalidSort = await get(
    app,
    "/api/admin?sortBy=id;drop&order=sideways",
    { headers: cookie },
  );
  const invalidUpdate = await post(
    app,
    "/api/admin",
    { newUrl: "javascript:x", oldUrl: "not a url" },
    { headers: cookie },
  );

  expect(validSort.status).toBe(200);
  expect(invalidSort.status).toBe(422);
  expect(invalidUpdate.status).toBe(422);
  expect(sorts).toEqual([["subscriberCount", "desc"]]);
  expect(updates).toBe(0);
});

// Every route in the admin group, not just the one that used to be checked
// here. The guard is the group's now rather than each handler's, so this is
// what stops a route added there from being reachable by anyone signed in.
const adminOnlyRequests = [
  ["GET", "/api/admin", undefined],
  [
    "POST",
    "/api/admin",
    { newUrl: "https://b.test/", oldUrl: "https://a.test/" },
  ],
  ["DELETE", "/api/admin", { removeSourceId: 1 }],
  ["GET", "/api/admin/redirects", undefined],
  ["DELETE", "/api/admin/redirects", { oldUrl: "https://a.test/" }],
] as const;

test("allows admin sessions and rejects non-admin sessions", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.authenticate = async (sid) => ({
    ...sessionUser,
    isAdmin: sid === "admin",
  });
  const app = await appFor(dependencies);
  const call = (
    [method, path, body]: (typeof adminOnlyRequests)[number],
    sid: string,
  ) => send(app, method, path, body, { headers: { cookie: `sid=${sid}` } });

  const reader = await Promise.all(
    adminOnlyRequests.map((request) => call(request, "reader")),
  );
  const anonymous = await Promise.all(
    adminOnlyRequests.map((request) => call(request, "")),
  );
  const listing = await call(adminOnlyRequests[0], "admin");

  expect(reader.map((response) => response.status)).toEqual(
    adminOnlyRequests.map(() => 403),
  );
  expect(anonymous.map((response) => response.status)).toEqual(
    adminOnlyRequests.map(() => 401),
  );
  expect(listing.status).toBe(200);
});

const signedInAsAdmin = (dependencies: Dependencies) => {
  dependencies.usersDataService.authenticate = async () => ({
    ...sessionUser,
    isAdmin: true,
  });
};

test.each([
  ["updated", 200, { success: true }],
  ["conflict", 409, { error: "Source URL already exists" }],
  ["not-found", 404, { error: "Source URL not found" }],
] as const)(
  "replacing a source URL that comes back %s answers %d",
  async (result, status, body) => {
    const dependencies = createDependencies();
    signedInAsAdmin(dependencies);
    const replacements: [string, string][] = [];
    dependencies.sourcesDataService.updateSourceUrl = async (
      oldUrl,
      newUrl,
    ) => {
      replacements.push([oldUrl, newUrl]);
      return result;
    };
    const app = await appFor(dependencies);

    const response = await post(
      app,
      "/api/admin",
      { newUrl: "https://b.test/", oldUrl: "https://a.test/" },
      { auth: true },
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
    expect(replacements).toEqual([["https://a.test/", "https://b.test/"]]);
  },
);

test("an admin deletes the source a request names", async () => {
  const dependencies = createDependencies();
  signedInAsAdmin(dependencies);
  const deleted: number[] = [];
  dependencies.sourcesDataService.deleteSource = async (sourceId) => {
    deleted.push(sourceId);
  };
  const app = await appFor(dependencies);

  const response = await send(
    app,
    "DELETE",
    "/api/admin",
    { removeSourceId: 7 },
    { auth: true },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toBe(7);
  expect(deleted).toEqual([7]);
});

test("an admin lists the redirect map and removes one entry", async () => {
  const dependencies = createDependencies();
  signedInAsAdmin(dependencies);
  const redirects: Record<string, string> = {
    "https://a.test/": "https://b.test/",
    "https://c.test/": "https://d.test/",
  };
  dependencies.redirectMap.getAllRedirects = async () => ({ ...redirects });
  dependencies.redirectMap.removeRedirect = async (oldUrl) => {
    delete redirects[oldUrl];
  };
  const app = await appFor(dependencies);

  const before = await get(app, "/api/admin/redirects", { auth: true });
  const removal = await send(
    app,
    "DELETE",
    "/api/admin/redirects",
    { oldUrl: "https://a.test/" },
    { auth: true },
  );
  const after = await get(app, "/api/admin/redirects", { auth: true });

  expect(before.status).toBe(200);
  expect(await before.json()).toEqual({
    "https://a.test/": "https://b.test/",
    "https://c.test/": "https://d.test/",
  });
  expect(removal.status).toBe(200);
  expect(await removal.json()).toEqual({ success: true });
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual({ "https://c.test/": "https://d.test/" });
});
