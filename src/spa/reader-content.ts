import { createSignal, type Accessor } from "solid-js";
import type { Article, ArticleSummary } from "#shared/contracts/responses.ts";
import { messageOf } from "./api.ts";
import {
  ReaderExtensionError,
  type createExtensionReaderBridge,
} from "./extension-reader.ts";
import type { ReaderContent, ReaderMode } from "./reader-extraction.ts";
import type { ArticleFetches } from "./reading-prefetch.ts";

export type DisplayMode = "FEED" | ReaderMode;

export const displayModes: {
  label: string;
  mode: DisplayMode;
  title: string;
}[] = [
  {
    label: "Feed",
    mode: "FEED",
    title: "The article as published in the feed",
  },
  {
    label: "Reader",
    mode: "READABILITY",
    title: "Cleaned-up reading view of the full article",
  },
  {
    label: "Reader (plain text)",
    mode: "READABILITY_PLAIN",
    title: "Reader view as plain text, no formatting or images",
  },
  {
    label: "Reader (fallback)",
    mode: "ARTICLE_EXTRACTOR",
    title: "A different extractor -- try this if Reader strips too much",
  },
];

type ReaderOptions = {
  bridge: ReturnType<typeof createExtensionReaderBridge>;
  clearAlert(): void;
  fetches: ArticleFetches;
  notice(message: string): void;
  reportError(cause: unknown, fallback: string): void;
};

export class ReaderState {
  readonly #options: ReaderOptions;
  readonly #mode = createSignal<DisplayMode>("FEED");
  readonly #available = createSignal(false);
  readonly #content = createSignal<ReaderContent>();
  readonly #opened = createSignal<Article>();
  readonly #loading = createSignal(false);
  #body: AbortController | undefined;
  #probe: AbortController | undefined;

  constructor(options: ReaderOptions) {
    this.#options = options;
  }

  readonly mode: Accessor<DisplayMode> = () => this.#mode[0]();
  readonly available: Accessor<boolean> = () => this.#available[0]();
  readonly opened: Accessor<Article | undefined> = () => this.#opened[0]();
  readonly loading: Accessor<boolean> = () => this.#loading[0]();

  readonly displayed: Accessor<
    { article: Article; content: ReaderContent } | undefined
  > = () => {
    const article = this.opened();
    if (!article) return undefined;
    if (this.mode() === "FEED")
      return {
        article,
        content: { content: article.content ?? "", kind: "html" },
      };
    const content = this.#content[0]();
    return content ? { article, content } : undefined;
  };

  setMode(mode: DisplayMode): void {
    this.#mode[1](mode);
  }

  async probe(): Promise<void> {
    this.#probe?.abort();
    const probe = new AbortController();
    this.#probe = probe;
    const available = await this.#options.bridge.available();
    if (probe.signal.aborted) return;
    this.#available[1](available);
    if (!available && this.mode() !== "FEED")
      this.#fallBackToFeed(
        "The Reader extension is unavailable. Showing Feed mode.",
      );
  }

  close(): void {
    this.#body?.abort();
    this.#opened[1](undefined);
    this.#content[1](undefined);
    this.#loading[1](false);
  }

  async open(
    summary: ArticleSummary,
    isCurrent: () => boolean,
    arrived: (article: Article) => void,
  ): Promise<void> {
    this.#body?.abort();
    const body = this.#options.fetches.open(summary.id);
    this.#body = body.controller;
    const mode = this.mode();
    const current = () =>
      !body.controller.signal.aborted && mode === this.mode() && isCurrent();
    this.#opened[1](undefined);
    this.#content[1](undefined);
    this.#loading[1](true);
    this.#options.clearAlert();
    try {
      const opened = await body.request;
      if (!current()) return;
      this.#opened[1](opened);
      arrived(opened);
      if (mode === "FEED") return;
      if (!this.available()) throw new ReaderExtensionError("UNAVAILABLE");
      const fetched = await this.#options.bridge.fetch(opened.url);
      if (!current()) return;
      const { extractReaderContent } = await import("./reader-extraction.ts");
      if (!current()) return;
      const content = await extractReaderContent(
        fetched.html,
        fetched.finalUrl,
        mode,
      );
      if (!current()) return;
      this.#content[1](content);
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof ReaderExtensionError && cause.unavailable) {
        this.#fallBackToFeed(`${cause.message} Showing Feed mode.`);
        return;
      }
      if (mode !== "FEED") {
        this.#mode[1]("FEED");
        this.#content[1](undefined);
        this.#options.notice(
          `${messageOf(cause, "Could not load Reader content.")} Showing Feed mode.`,
        );
        return;
      }
      this.#options.reportError(cause, "Could not load the article");
    } finally {
      if (!body.controller.signal.aborted) this.#loading[1](false);
    }
  }

  dispose(): void {
    this.#probe?.abort();
    this.#body?.abort();
    this.#options.bridge.dispose();
  }

  #fallBackToFeed(message: string): void {
    this.#body?.abort();
    this.#available[1](false);
    this.#mode[1]("FEED");
    this.#content[1](undefined);
    this.#loading[1](false);
    this.#options.notice(message);
  }
}
