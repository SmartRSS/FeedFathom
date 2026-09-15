import { describe, expect, test } from "bun:test";
import { HttpDeadlineError, RequestDeadline } from "../request-deadline.ts";

const never = new Promise<never>(() => {});

describe("RequestDeadline", () => {
  // The transport is handed this signal, so expiry has to cancel an in-flight
  // read rather than wait for it to return on its own.
  test("aborts its controller when the budget runs out", async () => {
    const deadline = new RequestDeadline(10);
    expect(deadline.controller.signal.aborted).toBe(false);
    await expect(deadline.run(never)).rejects.toBeInstanceOf(HttpDeadlineError);
    expect(deadline.controller.signal.aborted).toBe(true);
    deadline.dispose();
  });

  test("assertActive throws once expired", async () => {
    const deadline = new RequestDeadline(10);
    deadline.assertActive();
    await expect(deadline.run(never)).rejects.toBeInstanceOf(HttpDeadlineError);
    expect(() => {
      deadline.assertActive();
    }).toThrow(HttpDeadlineError);
    deadline.dispose();
  });

  test("rejects an already-resolved operation after expiry", async () => {
    const deadline = new RequestDeadline(10);
    await expect(deadline.run(never)).rejects.toBeInstanceOf(HttpDeadlineError);
    await expect(deadline.run(Promise.resolve("late"))).rejects.toBeInstanceOf(
      HttpDeadlineError,
    );
    deadline.dispose();
  });

  test("sleep resolves within the budget", async () => {
    const deadline = new RequestDeadline(1_000);
    const before = Date.now();
    await deadline.sleep(20);
    expect(Date.now() - before).toBeGreaterThanOrEqual(15);
    deadline.dispose();
  });

  // A backoff longer than what is left must fail the request rather than
  // sleep past the deadline and then continue.
  test("sleep past the budget rejects", async () => {
    const deadline = new RequestDeadline(20);
    await expect(deadline.sleep(5_000)).rejects.toBeInstanceOf(
      HttpDeadlineError,
    );
    deadline.dispose();
  });

  // Without this the timer keeps the process alive after a fast request.
  test("passes a result through and disposal prevents later abort", async () => {
    const deadline = new RequestDeadline(50);
    expect(await deadline.run(Promise.resolve(1))).toBe(1);
    deadline.dispose();
    await Bun.sleep(75);
    expect(deadline.controller.signal.aborted).toBe(false);
  });
});
