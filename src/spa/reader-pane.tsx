import { For, Show } from "solid-js";
import type { Article } from "#shared/contracts/responses.ts";
import { ArticleMarkup } from "./article-markup.tsx";
import { Enclosures } from "./enclosures.tsx";
import type { ReaderContent } from "./reader-extraction.ts";
import { Icon } from "./icon.tsx";
import { BackButton } from "./page-toolbar.tsx";
import { displayModes, type ReaderState } from "./reader-content.ts";
import { ReaderHeader } from "./reader-header.tsx";
import removeRaw from "./assets/icons/System/delete-bin-7-fill.svg?raw";
import settingsRaw from "./assets/icons/System/settings-5-fill.svg?raw";
import shareRaw from "./assets/icons/System/share-fill.svg?raw";

const READER_SKELETON_PARAGRAPHS = [
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod",
  "Tempor incididunt ut labore et dolore magna aliqua ut enim ad minim",
  "Veniam quis nostrud exercitation ullamco laboris nisi ut aliquip",
  "Ex ea commodo consequat duis aute irure dolor",
  "In reprehenderit in voluptate velit esse cillum dolore eu fugiat",
  "Nulla pariatur excepteur sint occaecat",
];

function ReaderBody(props: { article: Article; content: ReaderContent }) {
  return (
    <>
      <Enclosures article={props.article} body={props.content.content} />
      {props.content.kind === "html" ? (
        <ArticleMarkup html={props.content.content} />
      ) : (
        <div class="reader-plain">{props.content.content}</div>
      )}
    </>
  );
}

export function ReaderPane(props: {
  backPane(): void;
  // What the pane says with no article to show.
  emptyMessage: string;
  feedName(article: Article): string | undefined;
  focused: boolean;
  // One article is selected, whether or not its body is in.
  hasArticle: boolean;
  onDelete(event: Event): void;
  onKeyDown(event: KeyboardEvent): void;
  onModeChange(): void;
  onOptions(): void;
  onScroll(reader: HTMLElement): void;
  onShare(): void;
  reader: ReaderState;
  readerRef(element: HTMLElement): void;
  ref(element: HTMLElement): void;
}) {
  return (
    <article
      aria-label="Reader"
      class="dashboard-pane reader-pane"
      classList={{ "focused-pane": props.focused }}
      onKeyDown={(event) => props.onKeyDown(event)}
      ref={props.ref}
      tabIndex={-1}
    >
      <div class="toolbar">
        <BackButton backPane={props.backPane} />
        <button
          aria-label="delete article"
          title="Delete article"
          disabled={!props.hasArticle}
          onClick={(event) => props.onDelete(event)}
        >
          <Icon raw={removeRaw} />
          <span class="toolbar-label">Delete</span>
        </button>
        <button
          aria-label="share article"
          title="Share"
          disabled={!props.hasArticle}
          onClick={() => props.onShare()}
        >
          <Icon raw={shareRaw} />
          <span class="toolbar-label">Share</span>
        </button>
        <span />
        <Show when={props.reader.available()}>
          <select
            aria-label="Article display mode"
            value={props.reader.mode()}
            onChange={(event) => {
              const value = event.currentTarget.value;
              props.reader.setMode(
                displayModes.find((option) => option.mode === value)?.mode ??
                  "FEED",
              );
              props.onModeChange();
            }}
          >
            <For each={displayModes}>
              {(option) => (
                <option value={option.mode} title={option.title}>
                  {option.label}
                </option>
              )}
            </For>
          </select>
        </Show>
        <button
          aria-label="options"
          title="Options"
          onClick={() => props.onOptions()}
        >
          <Icon raw={settingsRaw} />
          <span class="toolbar-label">Options</span>
        </button>
      </div>
      <div
        class="reader"
        classList={{
          skeleton: props.reader.loading() && !props.reader.displayed(),
        }}
        ref={props.readerRef}
        onScroll={(event) => props.onScroll(event.currentTarget)}
      >
        <Show
          when={props.reader.displayed()}
          fallback={
            <Show
              when={props.reader.loading()}
              fallback={
                <Show
                  when={props.hasArticle}
                  fallback={<p class="empty-pane">{props.emptyMessage}</p>}
                >
                  <p>Reader content unavailable.</p>
                </Show>
              }
            >
              <h1 class="skeleton-text" aria-hidden="true">
                An Example Article Headline
              </h1>
              <For each={READER_SKELETON_PARAGRAPHS}>
                {(paragraph) => (
                  <p class="skeleton-text" aria-hidden="true">
                    {paragraph}
                  </p>
                )}
              </For>
            </Show>
          }
        >
          {(item) => (
            <>
              <ReaderHeader
                author={item().article.author}
                feed={props.feedName(item().article)}
                publishedAt={item().article.publishedAt}
                title={item().article.title}
                url={item().article.url}
              />
              <ReaderBody article={item().article} content={item().content} />
            </>
          )}
        </Show>
      </div>
    </article>
  );
}
