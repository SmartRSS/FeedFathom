import { Icon } from "./icon.tsx";
import backRaw from "./assets/icons/Arrows/arrow-left-fill.svg?raw";

// The top bar of a page outside the dashboard (Options, Admin): the same
// toolbar the panes use, with a way back to the dashboard and the page's
// title. The way back is a link, since it goes to an address: "/".
export function PageToolbar(props: {
  navigate(to: string): void;
  title: string;
}) {
  return (
    <div class="toolbar page-toolbar">
      <a
        aria-label="Home"
        class="toolbar-link"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          props.navigate("/");
        }}
      >
        <Icon raw={backRaw} />
      </a>
      <h1 class="toolbar-title">{props.title}</h1>
    </div>
  );
}
