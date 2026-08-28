import { describe, expect, test } from "bun:test";
import { createSupersessionGuard } from "../supersession.ts";

describe("supersession guard", () => {
  test("a fresh token is current until a newer one starts", () => {
    const guard = createSupersessionGuard();
    const token = guard.start();
    expect(guard.isCurrent(token)).toBe(true);
  });

  test("starting a new token supersedes the previous one", () => {
    const guard = createSupersessionGuard();
    const first = guard.start();
    const second = guard.start();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  test("guards are independent of each other", () => {
    const a = createSupersessionGuard();
    const b = createSupersessionGuard();
    const tokenA = a.start();
    b.start();
    expect(a.isCurrent(tokenA)).toBe(true);
  });

  test("current() peeks the latest token without starting a new one", () => {
    const guard = createSupersessionGuard();
    const token = guard.start();
    expect(guard.current()).toBe(token);
    expect(guard.current()).toBe(token);
  });
});
