const VIDEO_ID = /^[\w-]{11}$/;

export function youtubeVideoId(url: null | string | undefined) {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^(www|m)\./, "");
  const id =
    host === "youtu.be"
      ? parsed.pathname.slice(1)
      : host === "youtube.com"
        ? parsed.pathname === "/watch"
          ? parsed.searchParams.get("v")
          : /^\/(embed|live|shorts|v)\/([^/]+)/.exec(parsed.pathname)?.[2]
        : undefined;
  return id && VIDEO_ID.test(id) ? id : undefined;
}
