import { expect, test } from "bun:test";
import { strictFake } from "#shared/__tests__/strict-fake.ts";
import {
  readerBridgeChannel,
  readerBridgeVersion,
  type ReaderRequest,
} from "#shared/extension-types.ts";
import { createExtensionReaderBridge } from "../extension-reader.ts";

const origin = "https://reader.example";

// Enough of a window for the bridge: it posts requests to itself and listens
// for answers, which the test delivers as message events.
function bridgeWindow() {
  const listeners: ((event: MessageEvent<unknown>) => void)[] = [];
  const posted: ReaderRequest[] = [];
  const windowObject: Window = strictFake<Window>(
    {
      addEventListener(_type: string, listener: unknown) {
        if (typeof listener === "function") listeners.push((e) => listener(e));
      },
      location: strictFake<Location>({ origin }),
      postMessage(message: ReaderRequest) {
        posted.push(message);
      },
      removeEventListener() {
        listeners.length = 0;
      },
    },
    "window",
  );
  const deliver = (data: unknown, from = { origin, source: windowObject }) => {
    // Bun's MessageEvent only takes a MessagePort as its source.
    const event = Object.defineProperty(
      new MessageEvent("message", { data, origin: from.origin }),
      "source",
      { value: from.source },
    );
    for (const listener of listeners) listener(event);
  };
  return { deliver, posted, windowObject };
}

const fetched = (id: string) => ({
  action: "fetch",
  channel: readerBridgeChannel,
  finalUrl: "https://article.example/story",
  html: "<p>Story</p>",
  id,
  ok: true,
  type: "response",
  version: readerBridgeVersion,
});

// The bridge is how article HTML from the extension enters the page, so an
// answer counts only if it comes from this window, on this origin, for the
// request it names; anything else -- another frame, another origin, a forged
// id or action -- is ignored, and the real answer still lands.
test("accepts only its own window's answer to the request it sent", async () => {
  const { deliver, posted, windowObject } = bridgeWindow();
  const bridge = createExtensionReaderBridge(windowObject);

  const pending = bridge.fetch("https://article.example/story");
  const [request] = posted;
  if (!request) throw new Error("no request was posted");
  expect(request.action).toBe("fetch");

  const forged = { ...fetched(request.id), html: "<p>Forged</p>" };
  deliver(forged, { origin: "https://evil.example", source: windowObject });
  deliver(forged, { origin, source: strictFake<Window>({}, "otherFrame") });
  deliver({ ...forged, id: "another-id" });
  deliver({ ...forged, action: "capabilities", available: true });
  deliver(fetched(request.id));

  expect(await pending).toEqual({
    finalUrl: "https://article.example/story",
    html: "<p>Story</p>",
  });
  bridge.dispose();
});

test("an extension error is surfaced by code, and dispose ends what is pending", async () => {
  const { deliver, posted, windowObject } = bridgeWindow();
  const bridge = createExtensionReaderBridge(windowObject);

  const refused = bridge.fetch("http://10.0.0.1/");
  deliver({
    action: "fetch",
    channel: readerBridgeChannel,
    error: "PRIVATE_URL",
    id: posted[0]?.id,
    ok: false,
    type: "response",
    version: readerBridgeVersion,
  });
  await expect(refused).rejects.toMatchObject({
    code: "PRIVATE_URL",
    unavailable: false,
  });

  const abandoned = bridge.fetch("https://article.example/other");
  bridge.dispose();
  await expect(abandoned).rejects.toThrow(
    "The Reader extension is unavailable.",
  );
});
