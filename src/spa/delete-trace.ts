const RECENT_LIMIT = 12;
const MAX_HEADER_LENGTH = 3000;

type TraceEntry = Record<string, boolean | number | string | undefined>;

const recent: TraceEntry[] = [];
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
  while (value.length > MAX_HEADER_LENGTH && trace.recent.length) {
    trace.recent = trace.recent.slice(1);
    value = JSON.stringify(trace);
  }
  return value.replaceAll(/[^ -~]/g, "?");
}
