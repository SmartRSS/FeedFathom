import { createEffect, onCleanup } from "solid-js";

// An article's sanitized HTML. A code block with long lines scrolls
// sideways, and a keyboard can scroll only what it can focus, so a block
// joins the tab order while it overflows. Watched for size rather than
// checked once: a block laid out in a hidden pane measures nothing until
// the pane shows.
export function ArticleMarkup(props: { html: string }) {
  let container: HTMLDivElement | undefined;
  createEffect(() => {
    void props.html;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const { target } of entries)
        if (target instanceof HTMLElement) {
          if (target.scrollWidth > target.clientWidth) target.tabIndex = 0;
          else target.removeAttribute("tabindex");
        }
    });
    for (const block of container.querySelectorAll("pre"))
      observer.observe(block);
    onCleanup(() => observer.disconnect());
  });
  return <div ref={container} innerHTML={props.html} />;
}
