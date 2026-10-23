import { expect, test } from "bun:test";
import { youtubeVideoId } from "../youtube-video-id.ts";

test("finds the video in every YouTube link shape", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube.com/v/dQw4w9WgXcQ?version=3",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
  ])
    expect(youtubeVideoId(url)).toBe("dQw4w9WgXcQ");
});

test("ignores anything that is not a YouTube video", () => {
  for (const url of [
    null,
    "",
    "not a url",
    "https://www.youtube.com/@channel",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    'https://youtu.be/dQw4w9WgXcQ"onload',
  ])
    expect(youtubeVideoId(url)).toBeUndefined();
});
