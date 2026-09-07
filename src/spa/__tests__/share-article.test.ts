import { expect, test } from "bun:test";
import { shareArticle } from "../share-article.ts";

const clipboardWrites: string[] = [];
const clipboard = {
  writeText: async (text: string) => {
    clipboardWrites.push(text);
  },
} as unknown as Clipboard;

// Each test reads the clipboard in isolation.
function freshClipboard() {
  clipboardWrites.length = 0;
  return clipboard;
}

function navigatorWithShare(
  behavior: (data: { title?: string; url?: string }) => Promise<void>,
): Navigator {
  return { share: behavior } as unknown as Navigator;
}

test("uses the Web Share sheet when the platform has one", async () => {
  const shared: Array<{ title?: string; url?: string }> = [];
  const outcome = await shareArticle(
    { title: "First article", url: "https://articles.example/first" },
    navigatorWithShare(async (data) => {
      shared.push(data);
    }),
    freshClipboard(),
  );
  expect(outcome).toBe("shared");
  expect(shared).toEqual([
    { title: "First article", url: "https://articles.example/first" },
  ]);
  expect(clipboardWrites).toEqual([]);
});

test("falls back to the clipboard where share is missing", async () => {
  const outcome = await shareArticle(
    { title: "First article", url: "https://articles.example/first" },
    {} as Navigator,
    freshClipboard(),
  );
  expect(outcome).toBe("copied");
  expect(clipboardWrites).toEqual(["https://articles.example/first"]);
});

test("a dismissed share sheet stays quiet instead of copying", async () => {
  const abort = new DOMException("user cancelled", "AbortError");
  const outcome = await shareArticle(
    { url: "https://articles.example/first" },
    navigatorWithShare(async () => {
      throw abort;
    }),
    freshClipboard(),
  );
  expect(outcome).toBe("dismissed");
  expect(clipboardWrites).toEqual([]);
});

test("a real share failure still lands in the clipboard", async () => {
  const outcome = await shareArticle(
    { url: "https://articles.example/first" },
    navigatorWithShare(async () => {
      throw new Error("share sheet crashed");
    }),
    freshClipboard(),
  );
  expect(outcome).toBe("copied");
  expect(clipboardWrites).toEqual(["https://articles.example/first"]);
});

test("an article without a URL does nothing", async () => {
  const outcome = await shareArticle(
    { title: "No link" },
    navigatorWithShare(async () => {}),
    freshClipboard(),
  );
  expect(outcome).toBe("dismissed");
});
