// Forensics for article deletes. On 2026-10-20 two articles were deleted
// 0.53 s apart, 17 s after the user's last click, and nothing on the client or
// the server could say what sent them. Every article DELETE now carries the
// event that triggered it and the input this tab saw just before it, and the
// server logs both with the request. A delete with no triggering event, or
// one whose recent input shows no click or key at all, then names itself.
//
// Only key names are kept: a printable key is recorded as "char", so the
// trace never holds anything the user typed.

export const DELETE_TRACE_HEADER = "X-FeedFathom-Trace";

const RECENT_LIMIT = 12;
// Request headers this size pass every proxy in front of the server.
const MAX_HEADER_LENGTH = 3000;

type TraceEntry = Record<string, boolean | number | string | undefined>;

const recent: TraceEntry[] = [];
// Distinguishes tabs in the server log: they share one session.
const tabId = Math.random().toString(36).slice(2, 8);
let lastDeleteAt: number | undefined;

const now = () => Math.round(performance.now());

function describeTarget(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const control = target.closest("button, a, [role=option], [data-index]");
  const element = control ?? target;
  const label =
    element.getAttribute("aria-label") ??
    element.getAttribute("data-index") ??
    element.className;
  return `${element.tagName.toLowerCase()}${label ? `[${label.slice(0, 40)}]` : ""}`;
}

function describeEvent(event: Event): TraceEntry {
  const entry: TraceEntry = {
    t: Math.round(event.timeStamp),
    target: describeTarget(event.target),
    trusted: event.isTrusted,
    type: event.type,
  };
  if (event instanceof KeyboardEvent) {
    entry["key"] = event.key.length === 1 ? "char" : event.key;
    entry["repeat"] = event.repeat;
  }
  if (event instanceof MouseEvent) {
    entry["button"] = event.button;
    entry["detail"] = event.detail;
  }
  if (event instanceof PointerEvent) entry["pointer"] = event.pointerType;
  return entry;
}

function remember(entry: TraceEntry) {
  recent.push(entry);
  if (recent.length > RECENT_LIMIT) recent.shift();
}

/** Starts recording input. Capture phase, so nothing the page stops is missed. */
export function installDeleteTrace(): void {
  for (const type of [
    "pointerdown",
    "pointerup",
    "click",
    "auxclick",
    "keydown",
    "keyup",
  ])
    addEventListener(type, (event) => remember(describeEvent(event)), {
      capture: true,
      passive: true,
    });
  for (const type of ["focus", "blur"])
    addEventListener(type, (event) => {
      if (event.target === window) remember({ t: now(), type });
    });
  document.addEventListener("visibilitychange", () =>
    remember({ state: document.visibilityState, t: now(), type: "visibility" }),
  );
}

/** The header value for one delete; `trigger` is the event that asked for it. */
export function deleteTrace(trigger: Event | undefined): string {
  const at = now();
  const trace = {
    focused: document.hasFocus(),
    recent,
    sinceLastDeleteMs: lastDeleteAt === undefined ? null : at - lastDeleteAt,
    t: at,
    tab: tabId,
    trigger: trigger ? describeEvent(trigger) : null,
    visibility: document.visibilityState,
  };
  lastDeleteAt = at;
  let value = JSON.stringify(trace);
  // Oldest input goes first: the trigger and the latest events matter most.
  while (value.length > MAX_HEADER_LENGTH && trace.recent.length) {
    trace.recent = trace.recent.slice(1);
    value = JSON.stringify(trace);
  }
  // Header values must be ASCII; a non-ASCII class name would make fetch throw.
  return value.replaceAll(/[^ -~]/g, "?");
}
