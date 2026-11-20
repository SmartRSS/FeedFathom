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
});
