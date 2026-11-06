import type { UsersDataService } from "#features/auth/user-data-service.ts";
import { digestToken } from "#features/auth/account-tokens.ts";
import { expect, spyOn, test } from "bun:test";
import { Value } from "typebox/value";
import { sessionResponse } from "#shared/contracts/responses.ts";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import type { AuthThrottle } from "#features/auth/auth-throttle.ts";
import type { ServerServices } from "../../../server-app.ts";
import {
  sessionUser,
  account,
  createDependencies,
  appFor,
  send,
  get,
  post,
  authenticated,
} from "../../../__tests__/server-harness.ts";

// The session row's activity stamp and device label are refreshed by the
// auth plugin on every request that resolves the cookie -- if the plugin
// stops passing the User-Agent along, the options list quietly reverts to
// login-time snapshots and nothing else in the app would notice.
test("each authenticated request refreshes the session row", async () => {
  const dependencies = createDependencies();
  const authenticatedWith: Parameters<UsersDataService["authenticate"]>[] = [];
  dependencies.usersDataService.authenticate = async (...args) => {
    authenticatedWith.push(args);
    return sessionUser;
  };
  const app = await appFor(dependencies);

  await get(app, "/api/options/sessions", {
    auth: true,
    headers: { "user-agent": "Mozilla/5.0 TestClient" },
  });
  expect(authenticatedWith).toEqual([["test", "Mozilla/5.0 TestClient"]]);

  // A request without a cookie has no row to refresh -- the plugin answers
  // 401 without reaching the database.
  authenticatedWith.length = 0;
  const unauthorized = await get(app, "/api/options/sessions", {
    headers: { "user-agent": "Mozilla/5.0 TestClient" },
  });
  expect(unauthorized.status).toBe(401);
  expect(authenticatedWith).toEqual([]);
});

test.each([undefined, "mail.example.com"])(
  "advertises the newsletter domain only where mail is minted (%p)",
  async (mailDomain) => {
    const dependencies = createDependencies();
    authenticated(dependencies);
    if (mailDomain) dependencies.config.mailDomain = mailDomain;
    const app = await appFor(dependencies);

    const response = await get(app, "/api/session", { auth: true });
    const body: unknown = await response.json();

    expect(Value.Check(sessionResponse, body)).toBe(true);
    expect(body).toEqual({
      ...(mailDomain ? { mailDomain } : {}),
      user: sessionUser,
    });
  },
);

test("ends only the current session and clears its cookie", async () => {
  const dependencies = createDependencies();
  const deleted: string[] = [];
  dependencies.usersDataService.deleteSession = async (sid) => {
    deleted.push(sid);
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/logout", undefined, {
    headers: { cookie: "sid=current-session" },
  });
  const withoutCookie = await post(app, "/api/logout");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(response.headers.get("set-cookie")).toBe(
    "sid=; HttpOnly; Max-Age=0; Path=/; SameSite=Lax",
  );
  expect(withoutCookie.status).toBe(200);
  expect(deleted).toEqual(["current-session"]);
});

test("authenticates only active users without revealing account state", async () => {
  const attempts = [
    { email: "missing@example.com", password: "password" },
    { email: account.email, password: "wrong-password" },
    { email: "inactive@example.com", password: "password" },
  ];

  /* eslint-disable no-await-in-loop -- Sequential, so a failure names the case that broke. */
  for (const attempt of attempts) {
    const dependencies = createDependencies();
    let sessionCalls = 0;
    let dummyHashCalls = 0;
    dependencies.usersDataService.findUser = async (email) => {
      if (email === account.email) return account;
      if (email === "inactive@example.com") {
        return { ...account, email, status: "inactive" };
      }
      return undefined;
    };
    dependencies.password.verify = async (value, hash) =>
      hash === account.password && value === "password";
    dependencies.usersDataService.createSession = async () => {
      sessionCalls++;
      return "unexpected-session";
    };
    dependencies.password.hash = async () => {
      dummyHashCalls++;
      return "dummy-hash";
    };
    const app = await appFor(dependencies);

    const response = await post(app, "/api/login", attempt);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Email or password is wrong.",
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(sessionCalls).toBe(0);
    expect(dummyHashCalls).toBe(
      attempt.email === "missing@example.com" ? 1 : 0,
    );
  }
  /* eslint-enable no-await-in-loop */

  const dependencies = createDependencies();
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "password";
  const app = await appFor(dependencies);
  const response = await post(app, "/api/login", {
    email: account.email,
    password: "password",
  });

  expect(response.status).toBe(200);
  // The session id travels only in the HttpOnly cookie, out of page script's
  // reach.
  expect(await response.json()).toEqual({ success: true });
  expect(response.headers.get("set-cookie")).toBe(
    "sid=test-session; HttpOnly; Max-Age=31536000; Path=/; SameSite=Lax",
  );
});

// The options page's session list is only as distinguishable as the stored
// agents: the route must hand the request's own User-Agent to createSession
// instead of a hardcoded blank. A missing header stays null here -- the
// "UNKNOWN" fallback is the data layer's decision.
test("login stores the request's user agent on the created session", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "password";
  const createdSessions: Array<{
    passwordHash: string;
    userId: number;
    userAgent: null | string | undefined;
  }> = [];
  dependencies.usersDataService.createSession = async (
    userId,
    passwordHash,
    userAgent,
  ) => {
    createdSessions.push({ passwordHash, userAgent, userId });
    return "test-session";
  };
  const app = await appFor(dependencies);
  const login = (userAgent?: string) =>
    post(
      app,
      "/api/login",
      { email: account.email, password: "password" },
      {
        headers: userAgent === undefined ? {} : { "user-agent": userAgent },
      },
    );

  expect((await login("Mozilla/5.0 FeedFathom Test")).status).toBe(200);
  expect((await login()).status).toBe(200);
  expect(createdSessions).toEqual([
    {
      passwordHash: account.password,
      userAgent: "Mozilla/5.0 FeedFathom Test",
      userId: account.id,
    },
    { passwordHash: account.password, userAgent: null, userId: account.id },
  ]);
});

// The session is issued against the hash the route verified. When a reset
// replaced it in between, the store issues nothing and the login is answered
// like any wrong password: no cookie, and the failure still counts (#843).
test("login refuses when the verified password was replaced before issuance", async () => {
  const dependencies = createDependencies();
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "password";
  dependencies.usersDataService.createSession = async () => undefined;
  const throttled: string[] = [];
  dependencies.authThrottle = strictFake<AuthThrottle>({
    async attempt() {
      throttled.push("attempt");
      return true;
    },
    async succeeded() {
      throttled.push("succeeded");
    },
  });
  const app = await appFor(dependencies);

  const response = await post(
    app,
    "/api/login",
    { email: account.email, password: "password" },
    { headers: { "x-forwarded-for": "203.0.113.9" } },
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: "Email or password is wrong.",
  });
  expect(response.headers.get("set-cookie")).toBeNull();
  // Counted and never taken back: it stays a failure.
  expect(throttled).toEqual(["attempt"]);
});

// Equal-time hashing on a miss closes the enumeration oracle but buys little
// on its own: an attacker who cannot tell accounts apart can still try
// passwords as fast as the box answers. The README's reverse-proxy setup adds
// no rate limiting of its own, so this cannot be left to the deployment.
test("stops guessing at one account from one address", async () => {
  const target = { ...account, email: "throttled@example.com" };
  const dependencies = createDependencies();
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  dependencies.usersDataService.findUser = async (email) =>
    email === target.email ? target : undefined;
  dependencies.password.verify = async (value, hash) =>
    hash === target.password && value === "password";
  const app = await appFor(dependencies);
  const attempt = (password: string, address: string) =>
    post(
      app,
      "/api/login",
      { email: target.email, password },
      { headers: { "x-forwarded-for": address } },
    );

  for (let guess = 0; guess < 10; guess++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    expect((await attempt("wrong", "203.0.113.7")).status).toBe(401);
  }

  // Same body and status as a wrong password, so the throttle does not become
  // the enumeration signal the equal-time hashing was there to avoid.
  const throttled = await attempt("password", "203.0.113.7");
  expect(throttled.status).toBe(401);
  expect(await throttled.json()).toEqual({
    error: "Email or password is wrong.",
  });

  // The account itself is not locked: the counter is keyed on the address as
  // well, so hammering an address cannot shut its owner out from elsewhere.
  const elsewhere = await attempt("password", "198.51.100.4");
  expect(elsewhere.status).toBe(200);
});

// What stays counted is failures: the right password takes its own attempt
// back, so a user who mistyped nine times starts the next window fresh.
test("a successful login clears the guesses counted against it", async () => {
  const dependencies = createDependencies();
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  dependencies.usersDataService.findUser = async () => account;
  let verifyCalls = 0;
  dependencies.password.verify = async (value) => {
    verifyCalls++;
    return value === "password";
  };
  const app = await appFor(dependencies);
  const attempt = (password: string) =>
    post(
      app,
      "/api/login",
      { email: account.email, password },
      { headers: { "x-forwarded-for": "203.0.113.7" } },
    );

  for (let guess = 0; guess < 9; guess++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await attempt(`typo-${guess}`);
  }
  expect((await attempt("password")).status).toBe(200);
  for (let guess = 0; guess < 10; guess++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await attempt(`typo-again-${guess}`);
  }
  expect(verifyCalls).toBe(20);
});

// A check before the password and a failure recorded after it let a burst all
// pass the check before any was counted; counting first is what holds.
test("a parallel burst of guesses reaches the password check at most the limit", async () => {
  const dependencies = createDependencies();
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  dependencies.usersDataService.findUser = async () => account;
  let verifyCalls = 0;
  dependencies.password.verify = async () => {
    verifyCalls++;
    await Bun.sleep(1);
    return false;
  };
  const app = await appFor(dependencies);

  const responses = await Promise.all(
    Array.from({ length: 200 }, (_, guess) =>
      post(
        app,
        "/api/login",
        { email: account.email, password: `guess-${guess}` },
        { headers: { "x-forwarded-for": "203.0.113.7" } },
      ),
    ),
  );

  expect(responses.every((response) => response.status === 401)).toBe(true);
  expect(verifyCalls).toBe(10);
});

test("rejects mismatched registration passwords before the handler", async () => {
  const dependencies = createDependencies();
  let handlerCalls = 0;
  dependencies.usersDataService.getUserCount = async () => {
    handlerCalls++;
    return 0;
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "reader@example.com",
    password: "password",
    passwordConfirm: "different",
    username: "Reader",
  });

  expect(response.status).toBe(422);
  expect(handlerCalls).toBe(0);
});

test("rejects mismatched password changes before account checks", async () => {
  const dependencies = createDependencies();
  let accountChecks = 0;
  authenticated(dependencies);
  dependencies.usersDataService.findUser = async () => {
    accountChecks++;
    return account;
  };
  const app = await appFor(dependencies);

  const response = await post(
    app,
    "/api/options/password",
    {
      oldPassword: "old",
      password1: "new-password",
      password2: "different",
    },
    { auth: true },
  );

  expect(response.status).toBe(422);
  expect(accountChecks).toBe(0);
});

// The write is conditional on the hash the handler verified, so a reset that
// committed while the replacement was hashing wins and the change is refused
// rather than reported as done (#977).
test("refuses a password change whose verified password was replaced", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.authenticate = async () => sessionUser;
  dependencies.usersDataService.findUser = async () => account;
  dependencies.password.verify = async (value, hash) =>
    hash === account.password && value === "old-password";
  dependencies.password.hash = async () => "replacement-hash";
  const updates: Parameters<UsersDataService["updatePassword"]>[] = [];
  dependencies.usersDataService.updatePassword = async (...args) => {
    updates.push(args);
    return false;
  };
  const app = await appFor(dependencies);

  const response = await post(
    app,
    "/api/options/password",
    {
      oldPassword: "old-password",
      password1: "new-password",
      password2: "new-password",
    },
    { auth: true },
  );

  expect(updates).toEqual([
    [account.id, account.password, "replacement-hash", "test"],
  ]);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Current password is incorrect.",
  });
});

// A stolen session must not be a way to grind the account's real password.
// Counted per user, so changing address does not reset the budget.
test("stops guessing the current password from one session", async () => {
  const dependencies = createDependencies();
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  authenticated(dependencies);
  dependencies.usersDataService.findUser = async () => account;
  let verifyCalls = 0;
  dependencies.password.verify = async (value, hash) => {
    verifyCalls++;
    return hash === account.password && value === "old-password";
  };
  dependencies.usersDataService.updatePassword = async () => true;
  const app = await appFor(dependencies);
  const change = (oldPassword: string, address: string) =>
    post(
      app,
      "/api/options/password",
      { oldPassword, password1: "new-password", password2: "new-password" },
      { auth: true, headers: { "x-forwarded-for": address } },
    );

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await change(`guess-${attempt}`, `203.0.113.${attempt}`);
  }
  expect(verifyCalls).toBe(10);

  // Even the right password, from a fresh address, is refused unchecked. The
  // caller is signed in, so the refusal can say what it is.
  const blocked = await change("old-password", "198.51.100.4");
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({
    error: "Too many attempts. Try again later.",
  });
  expect(verifyCalls).toBe(10);
});

test("a successful password change clears the session's guess count", async () => {
  const dependencies = createDependencies();
  authenticated(dependencies);
  dependencies.usersDataService.findUser = async () => account;
  let verifyCalls = 0;
  dependencies.password.verify = async (value) => {
    verifyCalls++;
    return value === "old-password";
  };
  dependencies.usersDataService.updatePassword = async () => true;
  const app = await appFor(dependencies);
  const change = (oldPassword: string) =>
    post(
      app,
      "/api/options/password",
      { oldPassword, password1: "new-password", password2: "new-password" },
      { auth: true },
    );

  for (let attempt = 0; attempt < 9; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await change(`typo-${attempt}`);
  }
  expect((await change("old-password")).status).toBe(200);

  // A fresh budget: ten more mistakes all reach the check.
  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    expect((await change(`typo-again-${attempt}`)).status).toBe(400);
  }
  expect(verifyCalls).toBe(20);
});

test("creates active users without registration integrations", async () => {
  const dependencies = createDependencies();
  let created:
    | Parameters<ServerServices["usersDataService"]["createUser"]>[0]
    | undefined;
  let fetchCalls = 0;
  let mailCalls = 0;
  dependencies.fetcher = async () => {
    fetchCalls++;
    throw new Error("Unexpected fetch");
  };
  dependencies.password.hash = async () => "hashed-password";
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async (payload) => {
    created = payload;
    return "created";
  };
  dependencies.mailSender.sendActivationEmail = async () => {
    mailCalls++;
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "active@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Active user",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(created).toEqual({
    email: "active@example.com",
    name: "Active user",
    passwordHash: "hashed-password",
    status: "active",
  });
  expect(fetchCalls).toBe(0);
  expect(mailCalls).toBe(0);
});

// With Mailjet configured an existing address gets a notice instead; see
// the account-exists and expired-link tests further down.
test.each(["active", "inactive"] as const)(
  "returns generic success without mutating an existing %s account when mail is off",
  async (status) => {
    const dependencies = createDependencies();
    const calls: string[] = [];
    dependencies.password.hash = async () => {
      calls.push("hash");
      return "replacement-hash";
    };
    dependencies.usersDataService.findUser = async () => ({
      ...account,
      status,
    });
    dependencies.usersDataService.createUser = async () => {
      calls.push("create");
      return "created";
    };
    dependencies.usersDataService.updatePassword = async () => {
      calls.push("update-password");
      return true;
    };
    dependencies.usersDataService.activate = async () => {
      calls.push("activate");
      return true;
    };
    dependencies.mailSender.sendActivationEmail = async () => {
      calls.push("send");
    };
    const app = await appFor(dependencies);

    const response = await post(app, "/api/register", {
      email: account.email,
      password: "replacement-password",
      passwordConfirm: "replacement-password",
      username: "Replacement name",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    // The hash a new address would pay for, so the two answer in equal time.
    expect(calls).toEqual(["hash"]);
  },
);

// Registration with mail configured is a way to send a message from this
// instance's domain to an address a stranger chose. ENABLE_REGISTRATION and
// ALLOWED_EMAILS say who may hold an account; neither bounds how many mails
// an open form will emit. Turnstile is the documented answer and this is the
// floor under a deployment that has not set it.
test("stops an open signup form from mailing strangers on demand", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  let mailCalls = 0;
  dependencies.password.hash = async () => "hashed-password";
  dependencies.usersDataService.getUserCount = async () => 1;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => "created";
  dependencies.mailSender.sendActivationEmail = async () => {
    mailCalls++;
  };
  const app = await appFor(dependencies);
  const register = (email: string, address: string) =>
    post(
      app,
      "/api/register",
      {
        email,
        password: "password",
        passwordConfirm: "password",
        username: "Stranger",
      },
      { headers: { "x-forwarded-for": address } },
    );

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await register("stranger@example.com", "203.0.113.7");
  }
  expect(mailCalls).toBe(10);

  // Counted per address whether or not the account exists, so saying so
  // answers nothing about who has one -- and no mail leaves.
  const blocked = await register("stranger@example.com", "203.0.113.7");
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({
    error: "Too many attempts. Try again later.",
  });
  expect(mailCalls).toBe(10);

  // Keyed on the address too, so spending one address's budget cannot stop
  // anyone else from signing up.
  await register("stranger@example.com", "198.51.100.4");
  expect(mailCalls).toBe(11);
});

// Without mail there is nothing to send, but every attempt still costs a
// password hash, so the form is bounded the same way.
test("throttles registration when email activation is off", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  let hashCalls = 0;
  dependencies.password.hash = async () => {
    hashCalls++;
    return "hashed-password";
  };
  dependencies.usersDataService.getUserCount = async () => 1;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => "created";
  const app = await appFor(dependencies);
  const register = () =>
    post(
      app,
      "/api/register",
      {
        email: "stranger@example.com",
        password: "password",
        passwordConfirm: "password",
        username: "Stranger",
      },
      { headers: { "x-forwarded-for": "203.0.113.7" } },
    );

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await register();
  }
  expect(hashCalls).toBe(10);

  // Not the success it would otherwise claim: no account was made.
  const blocked = await register();
  expect(blocked.status).toBe(429);
  expect(hashCalls).toBe(10);
});

// A failed account-exists notice answers like a sent one; the failure is
// logged instead of returned.
test("a failed account-exists notice still answers generic success", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  dependencies.usersDataService.findUser = async () => account;
  dependencies.usersDataService.startPasswordReset = async () => "reset-token";
  dependencies.mailSender.sendAccountExistsEmail = async () => {
    throw new Error("Mailjet unavailable");
  };
  const app = await appFor(dependencies);
  const logged = spyOn(console, "error").mockImplementation(() => {});

  try {
    const response = await post(app, "/api/register", {
      email: account.email,
      password: "password",
      passwordConfirm: "password",
      username: "Active user",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
});

// Only an address the caller named reaches a send, so waiting on Mailjet
// would time a pending or active account apart from a new one. A mail that
// never settles must not hold any of the three answers.
test.each([
  ["a new address", undefined],
  [
    "an inactive account with an expired link",
    { ...account, activationTokenExpiresAt: null, status: "inactive" as const },
  ],
  ["an active account", account],
] as const)(
  "registering %s answers without waiting on the mail",
  async (_label, existing) => {
    const dependencies = createDependencies();
    dependencies.config.ENABLE_REGISTRATION = true;
    dependencies.config.MAILJET_API_KEY = "mailjet-key";
    dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
    dependencies.usersDataService.findUser = async () => existing;
    dependencies.usersDataService.createUser = async () => "created";
    dependencies.usersDataService.refreshActivationToken = async () => true;
    dependencies.usersDataService.startPasswordReset = async () =>
      "reset-token";
    const sends: string[] = [];
    const never = new Promise<never>(() => {});
    dependencies.mailSender.sendActivationEmail = async () => {
      sends.push("activation");
      return await never;
    };
    dependencies.mailSender.sendAccountExistsEmail = async () => {
      sends.push("account-exists");
      return await never;
    };
    const app = await appFor(dependencies);

    // A route that awaited the mail would hang here until the test times out.
    const response = await post(app, "/api/register", {
      email: account.email,
      password: "password",
      passwordConfirm: "password",
      username: "Someone",
    });

    expect(response.status).toBe(200);
    expect(sends).toHaveLength(1);
  },
);

test("answers a disposable address with generic success and no account", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  let created = 0;
  dependencies.usersDataService.getUserCount = async () => 1;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => {
    created++;
    return "created";
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: " reader@mailinator.com ",
    password: "password",
    passwordConfirm: "password",
    username: "Stranger",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(created).toBe(0);
});

// A fresh install answers registration regardless of ENABLE_REGISTRATION, and
// answers it identically whether or not it worked. Someone fumbling their way
// into their own empty instance must not be able to lock themselves out of it
// for fifteen minutes with no way to tell that is what happened.
test("never throttles the first operator of an empty instance", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  let mailCalls = 0;
  dependencies.password.hash = async () => "hashed-password";
  dependencies.usersDataService.getUserCount = async () => 0;
  dependencies.usersDataService.findUser = async () => undefined;
  dependencies.usersDataService.createUser = async () => "created";
  dependencies.mailSender.sendActivationEmail = async () => {
    mailCalls++;
  };
  const app = await appFor(dependencies);

  for (let attempt = 0; attempt < 12; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    await post(app, "/api/register", {
      email: "operator@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Operator",
    });
  }
  expect(mailCalls).toBe(12);
});

test("rejects missing or malformed Turnstile responses before database mutation", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.TURNSTILE_SECRET_KEY = "turnstile-secret";
  let fetchCalls = 0;
  let hashCalls = 0;
  let databaseCalls = 0;
  dependencies.fetcher = async () => {
    fetchCalls++;
    return Response.json({ success: "true" });
  };
  dependencies.password.hash = async () => {
    hashCalls++;
    return "hashed-password";
  };
  dependencies.usersDataService.getUserCount = async () => {
    databaseCalls++;
    return 0;
  };
  dependencies.usersDataService.findUser = async () => {
    databaseCalls++;
    return undefined;
  };
  dependencies.usersDataService.createUser = async () => {
    databaseCalls++;
    return "created";
  };
  dependencies.usersDataService.updatePassword = async () => {
    databaseCalls++;
    return true;
  };
  dependencies.usersDataService.activate = async () => {
    databaseCalls++;
    return true;
  };
  const app = await appFor(dependencies);
  const register = (token?: string) =>
    post(app, "/api/register", {
      email: "protected@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Protected user",
      ...(token ? { "cf-turnstile-response": token } : {}),
    });

  const missing = await register();
  const failed = await register("invalid-token");

  expect(missing.status).toBe(400);
  expect(failed.status).toBe(400);
  expect(await missing.json()).toEqual({
    error: "Invalid CAPTCHA",
  });
  expect(await failed.json()).toEqual({
    error: "Invalid CAPTCHA",
  });
  expect(fetchCalls).toBe(1);
  expect(hashCalls).toBe(0);
  expect(databaseCalls).toBe(0);
});

test("creates inactive users and sends one activation email with Mailjet", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  dependencies.password.hash = async () => "hashed-password";
  let created:
    | Parameters<ServerServices["usersDataService"]["createUser"]>[0]
    | undefined;
  const sent: [string, string][] = [];
  const events: string[] = [];
  dependencies.usersDataService.createUser = async (payload) => {
    events.push("create");
    created = payload;
    return "created";
  };
  dependencies.mailSender.sendActivationEmail = async (email, token) => {
    events.push("send");
    sent.push([email, token]);
  };
  const app = await appFor(dependencies);

  const startedAt = Date.now();
  const response = await post(app, "/api/register", {
    email: "inactive@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Inactive user",
  });
  const finishedAt = Date.now();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  if (!created?.activationToken || !created.activationTokenExpiresAt)
    throw new Error("Activation fields were not created");
  expect(created.status).toBe("inactive");
  expect(created.activationToken).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(created.activationTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(
    startedAt + 24 * 60 * 60 * 1_000,
  );
  expect(created.activationTokenExpiresAt.getTime()).toBeLessThanOrEqual(
    finishedAt + 24 * 60 * 60 * 1_000,
  );
  expect(sent).toEqual([["inactive@example.com", created.activationToken]]);
  expect(events).toEqual(["create", "send"]);
});

// Mail goes out only for a committed row, so a failed delivery cannot leave a
// link to a token that was never stored. The row stays, and withdrawing its
// token turns the next registration attempt into an expired-link resend.
test("withdraws the stored activation token when delivery fails", async () => {
  const dependencies = createDependencies();
  dependencies.config.ENABLE_REGISTRATION = true;
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  const events: string[] = [];
  let stored: string | undefined;
  dependencies.usersDataService.createUser = async (payload) => {
    events.push("create");
    stored = payload.activationToken;
    return "created";
  };
  dependencies.mailSender.sendActivationEmail = async () => {
    events.push("send");
    throw new Error("Mailjet unavailable");
  };
  dependencies.usersDataService.withdrawActivationToken = async (token) => {
    events.push(token === stored ? "withdraw-stored" : "withdraw-other");
  };
  const app = await appFor(dependencies);
  const logged = spyOn(console, "error").mockImplementation(() => {});

  try {
    const response = await post(app, "/api/register", {
      email: "inactive@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Inactive user",
    });

    // Logged, not answered: an existing address whose send fails answers
    // success, so a new one must too.
    expect(response.status).toBe(200);
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
  expect(events).toEqual(["create", "send", "withdraw-stored"]);
});

// A same-address registration that lost the race to the insert gets the
// answer an existing account gets, and a failed insert mails nothing: every
// link sent points at a committed row (#848).
const lostRace: ServerServices["usersDataService"]["createUser"] = async () =>
  "exists";

const failedInsert: ServerServices["usersDataService"]["createUser"] =
  async () => {
    throw new Error("insert failed");
  };

test.each([
  ["lost the insert race", lostRace, 200],
  ["failed to insert", failedInsert, 500],
] as const)(
  "sends no activation mail when the account %s",
  async (_label, createUser, status) => {
    const dependencies = createDependencies();
    dependencies.config.ENABLE_REGISTRATION = true;
    dependencies.config.MAILJET_API_KEY = "mailjet-key";
    dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
    let mailCalls = 0;
    dependencies.usersDataService.createUser = createUser;
    dependencies.mailSender.sendActivationEmail = async () => {
      mailCalls++;
    };
    const app = await appFor(dependencies);

    const response = await post(app, "/api/register", {
      email: "racer@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Racer",
    });

    expect(response.status).toBe(status);
    if (status === 200)
      expect(await response.json()).toEqual({ success: true });
    expect(mailCalls).toBe(0);
  },
);

// The store, not the route's earlier count, has the last word on whether
// registration is open: a request that lost the bootstrap race is refused
// like any other while registration is disabled, and nothing is mailed.
test.each([false, true])(
  "refuses a registration the store closed, with Mailjet=%s",
  async (useMailjet) => {
    const dependencies = createDependencies();
    if (useMailjet) {
      dependencies.config.MAILJET_API_KEY = "mailjet-key";
      dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
    }
    let registrationEnabled: boolean | undefined;
    let mailCalls = 0;
    dependencies.usersDataService.getUserCount = async () => 0;
    dependencies.usersDataService.createUser = async (_payload, enabled) => {
      registrationEnabled = enabled;
      return "closed";
    };
    dependencies.mailSender.sendActivationEmail = async () => {
      mailCalls++;
    };
    const app = await appFor(dependencies);

    const response = await post(app, "/api/register", {
      email: "second@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Second",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Registration is currently disabled",
    });
    expect(registrationEnabled).toBe(false);
    expect(mailCalls).toBe(0);
  },
);

// The recovery path a forgotten password needs, and every way it must refuse
// to say more than it should.
test("resets a password without admitting whether the account exists", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "key";
  dependencies.config.MAILJET_API_SECRET = "secret";
  const target = { ...account, email: "forgetful@example.com" };
  const sent: { email: string; token: string }[] = [];
  const started: number[] = [];
  dependencies.usersDataService.findUser = async (email) =>
    email === target.email ? target : undefined;
  dependencies.usersDataService.startPasswordReset = async (userId) => {
    started.push(userId);
    return "issued-token";
  };
  dependencies.mailSender.sendPasswordResetEmail = async (email, token) => {
    sent.push({ email, token });
  };
  const app = await appFor(dependencies);
  const request = (email: string) =>
    post(app, "/api/password-reset", { email });

  const known = await request(target.email);
  const unknown = await request("nobody@example.com");
  const unknownBody: unknown = await unknown.json();

  expect(known.status).toBe(200);
  expect(unknown.status).toBe(200);
  expect(await known.json()).toEqual(unknownBody);
  expect(sent).toEqual([{ email: target.email, token: "issued-token" }]);
  expect(started).toEqual([target.id]);

  // The send is deliberately not awaited, so a Mailjet outage cannot make a
  // known address answer differently -- or more slowly -- than an unknown one.
  dependencies.mailSender.sendPasswordResetEmail = async () => {
    throw new Error("Mailjet unavailable");
  };
  const undelivered = await request(target.email);
  expect(undelivered.status).toBe(200);
  expect(await undelivered.json()).toEqual(unknownBody);
});

// The reset form mails an address the caller names, so it is bounded like
// the login form: per (address, account), with the same 200 either way.
test("stops a reset form from mailing one account on demand", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "key";
  dependencies.config.MAILJET_API_SECRET = "secret";
  dependencies.config.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  const target = { ...account, email: "forgetful@example.com" };
  let sent = 0;
  dependencies.usersDataService.findUser = async () => target;
  dependencies.usersDataService.startPasswordReset = async () => "reset-token";
  dependencies.mailSender.sendPasswordResetEmail = async () => {
    sent++;
  };
  const app = await appFor(dependencies);
  const request = (address: string) =>
    post(
      app,
      "/api/password-reset",
      { email: target.email },
      { headers: { "x-forwarded-for": address } },
    );

  for (let attempt = 0; attempt < 10; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- The counter is the point.
    expect((await request("203.0.113.7")).status).toBe(200);
  }
  const throttled = await request("203.0.113.7");
  const elsewhere = await request("198.51.100.4");

  expect(throttled.status).toBe(200);
  expect(await throttled.json()).toEqual({ success: true });
  expect(elsewhere.status).toBe(200);
  expect(sent).toBe(11);

  // The reset counter is its own scope: tripping it does not lock the same
  // address out of signing in with the right password.
  dependencies.password.verify = async (value, hash) =>
    hash === target.password && value === "password";
  const login = await post(
    app,
    "/api/login",
    { email: target.email, password: "password" },
    { headers: { "x-forwarded-for": "203.0.113.7" } },
  );
  expect(login.status).toBe(200);
});

test("spends a reset token once and refuses one the store does not hold", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "key";
  dependencies.config.MAILJET_API_SECRET = "secret";
  const completed: {
    passwordHash: string;
    tokenHash: string;
    userId: number;
  }[] = [];
  dependencies.usersDataService.findUserByPasswordResetToken = async (
    tokenHash,
  ) =>
    tokenHash === digestToken("good")
      ? { ...account, passwordResetTokenHash: tokenHash }
      : undefined;
  dependencies.usersDataService.completePasswordReset = async (
    userId,
    tokenHash,
    passwordHash,
  ) => {
    completed.push({ passwordHash, tokenHash, userId });
    return true;
  };
  dependencies.password.hash = async (value) => `hashed:${value}`;
  const app = await appFor(dependencies);
  const confirm = (token: string, password1: string, password2 = password1) =>
    post(app, "/api/password-reset/confirm", { password1, password2, token });

  const good = await confirm("good", "a-new-password");
  const expired = await confirm("stale", "a-new-password");
  const mismatched = await confirm("good", "one", "two");

  expect(good.status).toBe(200);
  expect(expired.status).toBe(400);
  expect(mismatched.status).toBe(422);
  expect(completed).toEqual([
    {
      passwordHash: "hashed:a-new-password",
      tokenHash: digestToken("good"),
      userId: account.id,
    },
  ]);
});

// The spend must be part of the write itself (#809): a double that answers
// false stands in for the transaction losing the race, and the route has to
// answer the loser with the same refusal an unknown token gets.
test("a confirmation that loses the race for its link is refused", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.findUserByPasswordResetToken = async (
    tokenHash,
  ) => ({
    ...account,
    passwordResetTokenExpiresAt: new Date(Date.now() + 60_000),
    passwordResetTokenHash: tokenHash,
  });
  dependencies.usersDataService.completePasswordReset = async () => false;
  dependencies.password.hash = async (value) => `hashed:${value}`;
  const app = await appFor(dependencies);

  const rejected = await post(app, "/api/password-reset/confirm", {
    password1: "one",
    password2: "one",
    token: "t",
  });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({
    error: "This reset link is no longer valid.",
  });
});

test("has no reset flow at all when outgoing mail is not configured", async () => {
  const dependencies = createDependencies();
  let sends = 0;
  dependencies.usersDataService.findUser = async () => account;
  dependencies.mailSender.sendPasswordResetEmail = async () => {
    sends++;
  };
  const app = await appFor(dependencies);

  const info = await get(app, "/api/register");
  const requested = await post(app, "/api/password-reset", {
    email: account.email,
  });
  const confirmed = await post(app, "/api/password-reset/confirm", {
    password1: "x",
    password2: "x",
    token: "anything",
  });

  // The login view hides the link on this flag, and the request route still
  // answers exactly as it does for an account that does not exist.
  expect(await info.json()).toMatchObject({ passwordResetEnabled: false });
  expect(requested.status).toBe(200);
  expect(confirmed.status).toBe(400);
  expect(sends).toBe(0);
});

test("activates a token the store accepts and refuses any other", async () => {
  const dependencies = createDependencies();
  const tokenLookups: string[] = [];
  dependencies.usersDataService.activate = async (token) => {
    tokenLookups.push(token);
    return token === "valid";
  };
  const app = await appFor(dependencies);

  const valid = await post(app, "/api/activate/valid", undefined);
  const expired = await post(app, "/api/activate/expired", undefined);
  const blank = await post(app, "/api/activate/%20%20", undefined);

  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ success: true });
  expect(expired.status).toBe(400);
  expect(await expired.json()).toEqual({
    error: "Invalid activation token.",
  });
  expect(blank.status).toBe(422);
  expect(tokenLookups).toEqual(["valid", "expired"]);
});

// Re-registering over a half-made account renews an expired activation link,
// which is otherwise a dead end (#810). The route answers success either way
// -- the mailbox is what changes.
test("registering an address with an expired link sends a fresh one", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  const refreshed: { expiresAt: Date; token: string; userId: number }[] = [];
  const activationSends: string[] = [];
  dependencies.usersDataService.findUser = async (email) => ({
    ...account,
    activationToken: "old-token",
    activationTokenExpiresAt: new Date(Date.now() - 60_000),
    email,
    status: "inactive" as const,
  });
  dependencies.usersDataService.refreshActivationToken = async (
    userId,
    token,
    expiresAt,
  ) => {
    refreshed.push({ expiresAt, token, userId });
    return true;
  };
  dependencies.mailSender.sendActivationEmail = async (email) => {
    activationSends.push(email);
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "pending@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Pending user",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(activationSends).toEqual(["pending@example.com"]);
  expect(refreshed).toHaveLength(1);
  expect(refreshed[0]!.userId).toBe(account.id);
  // A fresh link promises a day, like the first one did.
  expect(refreshed[0]!.expiresAt.getTime()).toBeGreaterThan(
    Date.now() + 23 * 60 * 60 * 1_000,
  );
});

// A replacement link whose mail failed is withdrawn, so the next attempt
// sends another at once instead of finding an unexpired token and staying
// silent for a day (#849). A recovery that stored nothing sends nothing.
test("a failed replacement activation mail is retried on the next attempt", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  // An object, so the closures' writes are not narrowed away at the reads.
  const row: { token: null | string } = { token: null };
  let mailUp = false;
  const delivered: (null | string)[] = [];
  dependencies.usersDataService.findUser = async (email) => ({
    ...account,
    activationToken: row.token,
    activationTokenExpiresAt: row.token ? new Date(Date.now() + 60_000) : null,
    email,
    status: "inactive" as const,
  });
  dependencies.usersDataService.refreshActivationToken = async (
    _userId,
    token,
  ) => {
    if (row.token) return false;
    row.token = token;
    return true;
  };
  dependencies.usersDataService.withdrawActivationToken = async (token) => {
    if (row.token === token) row.token = null;
  };
  dependencies.mailSender.sendActivationEmail = async (_email, token) => {
    if (!mailUp) throw new Error("Mailjet unavailable");
    delivered.push(token);
  };
  const app = await appFor(dependencies);
  const register = () =>
    post(app, "/api/register", {
      email: "pending@example.com",
      password: "password",
      passwordConfirm: "password",
      username: "Pending user",
    });

  // The same answer as a delivered mail: a 500 here and not for an unknown
  // address would say which addresses hold accounts.
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const failed = await register();
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ success: true });
    expect(logged).toHaveBeenCalledTimes(1);
  } finally {
    logged.mockRestore();
  }
  expect(row.token).toBeNull();

  mailUp = true;
  const retried = await register();
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ success: true });
  expect(delivered).toEqual([row.token]);

  // The delivered link is live now, so a further attempt stores and sends
  // nothing and still answers the generic success.
  const again = await register();
  expect(await again.json()).toEqual({ success: true });
  expect(delivered).toHaveLength(1);
});

// An active account is not a half-made one, so no new activation -- the
// notice carries a reset link instead, the way in that never assumes the
// password still works.
test("registering an active address sends the account-exists reset notice", async () => {
  const dependencies = createDependencies();
  dependencies.config.MAILJET_API_KEY = "mailjet-key";
  dependencies.config.MAILJET_API_SECRET = "mailjet-secret";
  const resets: number[] = [];
  const notices: string[] = [];
  dependencies.usersDataService.findUser = async (email) => ({
    ...account,
    email,
  });
  dependencies.usersDataService.startPasswordReset = async (userId) => {
    resets.push(userId);
    return "reset-token";
  };
  dependencies.mailSender.sendAccountExistsEmail = async (email) => {
    notices.push(email);
  };
  const app = await appFor(dependencies);

  const response = await post(app, "/api/register", {
    email: "active@example.com",
    password: "password",
    passwordConfirm: "password",
    username: "Active user",
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(notices).toEqual(["active@example.com"]);
  expect(resets).toEqual([account.id]);
});

// Revocation is scoped by the signed-in user, never by anything the request
// names; sessions-integration covers that the data service honours the scope.
test("any signed-in user can revoke one of their sessions or all the others", async () => {
  const dependencies = createDependencies();
  dependencies.usersDataService.authenticate = async () => ({
    ...sessionUser,
    isAdmin: false,
  });
  const revoked: unknown[][] = [];
  dependencies.usersDataService.deleteSessionById = async (...args) => {
    revoked.push(["one", ...args]);
  };
  dependencies.usersDataService.deleteOtherSessions = async (...args) => {
    revoked.push(["others", ...args]);
  };
  const app = await appFor(dependencies);

  const listing = await get(app, "/api/options/sessions", { auth: true });
  const one = await send(app, "DELETE", "/api/options/sessions/7", undefined, {
    auth: true,
  });
  const malformed = await send(
    app,
    "DELETE",
    "/api/options/sessions/seven",
    undefined,
    { auth: true },
  );
  const others = await send(app, "DELETE", "/api/options/sessions", undefined, {
    auth: true,
  });

  expect(listing.status).toBe(200);
  expect([one.status, malformed.status, others.status]).toEqual([
    200, 422, 200,
  ]);
  expect(revoked).toEqual([
    ["one", sessionUser.id, 7],
    ["others", sessionUser.id, "test"],
  ]);
});
