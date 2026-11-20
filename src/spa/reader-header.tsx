import { Show } from "solid-js";
import { formatDate } from "./format-date.ts";

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
