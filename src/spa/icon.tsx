// Renders a bundled icon's raw SVG markup inline (see the `?raw` imports
// at each call site) instead of as an external <img src>. These icons are
// all fill/stroke="currentColor" by design -- inlining is what lets that
// resolve against the page's own text color instead of a fixed baked-in
// one, so every icon automatically matches its surroundings (dark-mode
// canvas text, a theme's selected-row foreground, etc.) with no per-case
// light/dark guessing.
export function Icon(props: { class?: string; raw: string }) {
  return (
    <span
      aria-hidden="true"
      class={`icon ${props.class ?? ""}`}
      innerHTML={props.raw}
    />
  );
}
