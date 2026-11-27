import { describe, expect, test } from "bun:test";
import { HttpDeadlineError, RequestDeadline } from "../request-deadline.ts";

const never = new Promise<never>(() => {});

describe("RequestDeadline", () => {
  test("aborts its controller when the budget runs out", async () => {
    const deadline = new RequestDeadline(10);
    expect(deadline.controller.signal.aborted).toBe(false);
    await expect(deadline.run(never)).rejects.toThrow(
      new HttpDeadlineError(10),
    );
    expect(String(deadline.controller.signal.reason)).toContain(
      "exceeded its 10 ms deadline",
    );
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

  test("sleep past the budget rejects", async () => {
    const deadline = new RequestDeadline(20);
    await expect(deadline.sleep(5_000)).rejects.toBeInstanceOf(
      HttpDeadlineError,
    );
    deadline.dispose();
  });

  test("passes a result through and disposal prevents later abort", async () => {
    const deadline = new RequestDeadline(50);
    expect(await deadline.run(Promise.resolve(1))).toBe(1);
    deadline.dispose();
    await Bun.sleep(75);
    expect(deadline.controller.signal.aborted).toBe(false);
  });

  test("a cancelled outer signal aborts the controller with its reason", async () => {
    const outer = new AbortController();
    const deadline = new RequestDeadline(5_000, outer.signal);
    const running = deadline.run(never);

    outer.abort(new Error("client left"));

    await expect(running).rejects.toThrow("client left");
    expect(deadline.controller.signal.reason).toEqual(new Error("client left"));
    expect(() => {
      deadline.assertActive();
    }).toThrow("client left");
    deadline.dispose();
  });

  test("an outer signal that is already aborted ends the deadline at once", async () => {
    const deadline = new RequestDeadline(5_000, AbortSignal.abort("gone"));

    expect(deadline.controller.signal.aborted).toBe(true);
    await expect(deadline.run(Promise.resolve(1))).rejects.toBe("gone");
    deadline.dispose();
  });

  test("disposal stops listening to the outer signal", () => {
    const outer = new AbortController();
    const deadline = new RequestDeadline(5_000, outer.signal);

    deadline.dispose();
    outer.abort();

    expect(deadline.controller.signal.aborted).toBe(false);
  });
});
