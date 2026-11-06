import { Show } from "solid-js";
import { formatDate } from "./format-date.ts";

// An article's title over one muted line: where it is from, who wrote it,
// when, and the way out to the original. The author is left out when it
// only repeats the feed's name, which is what a feed without authors falls
// back to; Original only when there is somewhere to go. The dashboard's
// reader and the feed preview both use it.
export function ReaderHeader(props: {
  author: string;
  feed: string | undefined;
  publishedAt: string;
  title: string;
  url: string | undefined;
}) {
  return (
    <header class="reader-header">
      <h1>{props.title}</h1>
      <p class="reader-meta">
        <span class="reader-meta-items">
          <span>
            <Show when={props.feed}>
              {(name) => (
                <span class="reader-meta-feed" title={name()}>
                  {name()}
                </span>
              )}
            </Show>
            <Show when={props.author && props.author !== props.feed}>
              <span title={props.author}>{props.author}</span>
            </Show>
            <time datetime={props.publishedAt}>
              {formatDate(props.publishedAt)}
            </time>
          </span>
        </span>
        <Show when={props.url}>{(url) => <a href={url()}>Original</a>}</Show>
      </p>
    </header>
  );
}
