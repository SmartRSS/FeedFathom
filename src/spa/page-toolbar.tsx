import { Icon } from "./icon.tsx";
import backRaw from "./assets/icons/Arrows/arrow-left-fill.svg?raw";

export function PageToolbar(props: {
  navigate(to: string): void;
  title: string;
}) {
  return (
    <div class="toolbar page-toolbar">
      <a
        aria-label="Home"
        title="Back to feeds"
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

export function BackButton(props: { always?: boolean; backPane(): void }) {
  return (
    <button
      aria-label="back"
      title="Back"
      class={{ "only-mobile": !props.always }}
      onClick={props.backPane}
    >
      <Icon raw={backRaw} />
      <span class="toolbar-label">Back</span>
    </button>
  );
}
