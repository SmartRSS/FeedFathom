import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { Enclosure } from "#shared/contracts/responses.ts";
import { enclosuresOpen, youtubeHost, youtubeLoad } from "./preferences.ts";
import { youtubeVideoId } from "./youtube-video-id.ts";

function YoutubeEmbed(props: { id: string; title: string }) {
  // Read once: changing the setting should not tear down a playing video.
  const onClick = youtubeLoad() === "click";
  const host = youtubeHost() === "youtube" ? "youtube" : "youtube-nocookie";
  const [loaded, setLoaded] = createSignal(!onClick);
  const src = () =>
    `https://www.${host}.com/embed/${props.id}${onClick ? "?autoplay=1" : ""}`;
  return (
    <div class="youtube-embed">
      <Show
        when={loaded()}
        fallback={
          // Smart-RSS's lite-youtube cover: the thumbnail and a play button,
          // nothing from YouTube's player until it is pressed.
          <button
            type="button"
            class="youtube-cover"
            aria-label={`Play ${props.title}`}
            style={{
              "background-image": `url("https://i.ytimg.com/vi/${props.id}/hqdefault.jpg")`,
            }}
            onClick={() => setLoaded(true)}
          />
        }
      >
        {/* YouTube refuses to play without a Referer (error 153). */}
        <iframe
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
          src={src()}
          title={props.title}
        />
      </Show>
    </div>
  );
}

const enclosureName = (enclosure: Enclosure) => {
  if (enclosure.title) return enclosure.title;
  const file = new URL(enclosure.url).pathname.split("/").pop();
  if (!file) return enclosure.url;
  try {
    return decodeURIComponent(file);
  } catch {
    return file;
  }
};

// What an article shows as attachments. A YouTube article stored before
// enclosures existed, or relayed without one, still gets its player; an image
// the body already shows is not shown twice.
const shownEnclosures = (
  article: { enclosures?: Enclosure[]; title: string; url: string },
  body: string,
): Enclosure[] => {
  const listed = article.enclosures ?? [];
  if (listed.length === 0 && youtubeVideoId(article.url))
    return [
      {
        medium: "other",
        mimeType: null,
        thumbnail: null,
        title: article.title,
        url: article.url,
      },
    ];
  return listed.filter(
    (enclosure) =>
      enclosure.medium !== "image" ||
      !body.includes(enclosure.url.replaceAll("&", "&amp;")),
  );
};

// Smart-RSS's layout: one collapsible block per attachment under the title,
// its name linking to the file. Players preload nothing; the file is fetched
// when it is played.
export function Enclosures(props: {
  article: { enclosures?: Enclosure[]; title: string; url: string };
  body: string;
}) {
  const items = () => shownEnclosures(props.article, props.body);
  const open = () =>
    enclosuresOpen() === "always" ||
    (enclosuresOpen() === "single" && items().length === 1);
  return (
    <For each={items()}>
      {(enclosure) => {
        const link = (
          <a href={enclosure.url} target="_blank" rel="noopener noreferrer">
            {enclosureName(enclosure)}
          </a>
        );
        const videoId = youtubeVideoId(enclosure.url);
        const playable = videoId !== undefined || enclosure.medium !== "other";
        return playable ? (
          <details class="enclosure" open={open()}>
            <summary>{link}</summary>
            <Switch>
              <Match when={videoId}>
                {(id) => <YoutubeEmbed id={id()} title={props.article.title} />}
              </Match>
              <Match when={enclosure.medium === "audio"}>
                <audio controls preload="none" src={enclosure.url} />
              </Match>
              <Match when={enclosure.medium === "video"}>
                <video
                  controls
                  preload="none"
                  poster={enclosure.thumbnail ?? undefined}
                  src={enclosure.url}
                />
              </Match>
              <Match when={enclosure.medium === "image"}>
                <img
                  alt={enclosure.title ?? ""}
                  loading="lazy"
                  src={enclosure.url}
                />
              </Match>
            </Switch>
          </details>
        ) : (
          <p class="enclosure">{link}</p>
        );
      }}
    </For>
  );
}
