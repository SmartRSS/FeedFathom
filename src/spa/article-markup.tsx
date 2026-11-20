import { createEffect } from "solid-js";

export function ArticleMarkup(props: { html: string }) {
  let container: HTMLDivElement | undefined;
  createEffect(
    () => props.html,
    () => {
      if (!container) return undefined;
      const observer = new ResizeObserver((entries) => {
        for (const { target } of entries)
          if (target instanceof HTMLElement) {
            if (target.scrollWidth > target.clientWidth) target.tabIndex = 0;
            else target.removeAttribute("tabindex");
          }
      });
      for (const block of container.querySelectorAll("pre"))
        observer.observe(block);
      return () => observer.disconnect();
    },
  );
  return <div ref={container} innerHTML={props.html} />;
}
