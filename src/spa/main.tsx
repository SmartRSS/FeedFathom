import {
  createEffect,
  createMemo,
  createSignal,
  Errored,
  lazy,
  Loading,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { render } from "@solidjs/web";
import { loginPath, resolveRoute, showsPanes, type Route } from "./routes.ts";
import {
  isDiscoveryEntry,
  parseDashboardPane,
  previousPath,
  switchPane,
  withDashboardPane,
  withDiscovery,
  type DashboardPane,
  type PaneSwitchHost,
} from "./panes.ts";
import { Dashboard } from "./dashboard.tsx";
import { DialogHost, isDialogOpen } from "./dialog.tsx";
import { installDeleteTrace } from "./delete-trace.ts";
import { isUnauthorizedError } from "./api.ts";
import {
  density,
  mobileListAnchor,
  readerText,
  readerWidth,
  resolvedTheme,
  unreadBadge,
} from "./preferences.ts";
import { unreadTotal } from "./news-signal.ts";
import { reloadForUpdate } from "./reading-session.ts";
import { isWorkerMessage } from "./sw-protocol.ts";
import "./style.css";

// Every route but the dashboard loads its chunk on first visit, so a
// dashboard launch never downloads or parses them (#880). The service worker
// caches a chunk once fetched; a route never visited online cannot open
// offline.
const Activate = lazy(async () => ({
  default: (await import("./account-flows.tsx")).Activate,
}));
const Login = lazy(async () => ({
  default: (await import("./account-flows.tsx")).Login,
}));
const PasswordReset = lazy(async () => ({
  default: (await import("./account-flows.tsx")).PasswordReset,
}));
const PasswordResetConfirm = lazy(async () => ({
  default: (await import("./account-flows.tsx")).PasswordResetConfirm,
}));
const Register = lazy(async () => ({
  default: (await import("./account-flows.tsx")).Register,
}));
const Admin = lazy(async () => ({
  default: (await import("./admin.tsx")).Admin,
}));
const Options = lazy(async () => ({
  default: (await import("./options.tsx")).Options,
}));

// A route swap replaces the whole page without the title change and focus
// reset a real navigation would give you: the tab keeps reading "FeedFathom"
// and Tab resumes from wherever the old page's link was.
const ROUTE_TITLES: Record<Route["name"], string> = {
  activate: "Account activation",
  admin: "Admin",
  dashboard: "FeedFathom",
  login: "Login",
  notFound: "Page not found",
  options: "Options",
  passwordReset: "Reset password",
  passwordResetConfirm: "Reset password",
  preview: "Discover feed",
  register: "Register",
};

// How the reader last drove the page, on <html> as data-input. The tree and
// list cursor ring belongs to keyboard use: the app focuses rows on its own
// (the first tree row on load), and :focus-visible counts that as keyboard
// focus in Chromium, so the ring showed before anyone had typed anything.
// A bare modifier is not input; Shift-click is still a pointer.
window.addEventListener(
  "keydown",
  (event) => {
    if (!["Alt", "Control", "Meta", "Shift"].includes(event.key))
      document.documentElement.dataset["input"] = "keyboard";
  },
  { capture: true },
);
window.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset["input"] = "pointer";
  },
  { capture: true },
);

// The service worker reported success for a change made offline, and the
// server refused it once back online. Nothing else tells the user, so it
// shows on whichever page is open.
const [offlineChangeLost, setOfflineChangeLost] = createSignal(false);

const currentPath = () => location.pathname + location.search;
const backPane = () => history.back();
const paneSwitchHost: PaneSwitchHost = {
  matches: (query) => matchMedia(query).matches,
  startViewTransition:
    "startViewTransition" in document
      ? (update) => {
          const transition = document.startViewTransition(update);
          // A second switch in the frame before this one's animation starts
          // skips it, which rejects `ready`. Nothing waits on the animation:
          // the switch itself still lands, through updateCallbackDone.
          transition.ready.catch(() => {});
          return transition;
        }
      : undefined,
};

function App() {
  const initialPath = currentPath();
  const initialRoute = resolveRoute(initialPath);
  const [path, setPath] = createSignal(initialPath);
  const [pane, setPane] = createSignal<DashboardPane>("sources");
  const [discovery, setDiscovery] = createSignal(false);

  const { dataset } = document.documentElement;
  createEffect(resolvedTheme, (theme) => {
    dataset["theme"] = theme;
  });
  // On the same element as the theme, so the reader rules can key off either
  // without a second host to reason about.
  createEffect(readerText.get, (text) => {
    dataset["readerText"] = text;
  });
  createEffect(density.get, (value) => {
    dataset["density"] = value;
  });
  createEffect(readerWidth.get, (width) => {
    dataset["readerWidth"] = width;
  });
  createEffect(mobileListAnchor.get, (anchor) => {
    dataset["mobileListAnchor"] = String(anchor);
  });

  // A reload starts on the feeds: Discover's half-filled form is gone, so
  // its entry would only reopen it empty.
  if (showsPanes(initialRoute))
    history.replaceState(
      withDiscovery(withDashboardPane(history.state, "sources"), false),
      "",
    );

  const navigate = (to: string) => {
    // Only off the panes: a pane switch copies its entry's state, return
    // address included, so there Back would land on the previous pane.
    if (!showsPanes(route()) && to === previousPath(history.state)) {
      history.back();
      return;
    }
    const nextRoute = resolveRoute(to);
    const nextPane = showsPanes(nextRoute) ? "sources" : undefined;
    const state = { feedFathomFrom: currentPath() };
    history.pushState(
      nextPane ? withDashboardPane(state, nextPane) : state,
      "",
      to,
    );
    setPath(to);
    setPane(nextPane ?? "sources");
    setDiscovery(false);
  };
  const handleUnauthorized = (cause: unknown) => {
    if (!isUnauthorizedError(cause)) return false;
    navigate(loginPath(currentPath()));
    return true;
  };
  // Under a view transition the switch lands a frame later, and until then
  // the new pane is still display:none: a focus() into it would drop to
  // <body>. Anything that focuses inside a pane waits for this.
  let paneShown: Promise<void> | undefined;
  const showPane = (update: () => void, browserAnimated?: boolean) => {
    const shown = switchPane(update, paneSwitchHost, browserAnimated);
    paneShown = shown;
    void shown?.then(() => {
      if (paneShown === shown) paneShown = undefined;
    });
  };
  // Without a transition the switch is a signal write, and the pane shows
  // at Solid's flush, which a microtask queued now runs after.
  const whenPaneShown = (run: () => void) => {
    if (paneShown) void paneShown.then(run);
    else queueMicrotask(run);
  };
  const focusPane = (next: DashboardPane) => {
    // history.state, not pane(): a pushed switch still waiting on its
    // transition has not set the signal yet, and a second tap in that frame
    // would push a duplicate entry that Back then has to step through.
    if (next === (parseDashboardPane(history.state) ?? pane())) return;
    history.pushState(withDashboardPane(history.state, next), "");
    showPane(() => setPane(next));
  };
  // Discover opens on the feeds pane; Back from it returns to whichever
  // pane it was opened over.
  const openDiscovery = () => {
    if (isDiscoveryEntry(history.state)) return;
    if ((parseDashboardPane(history.state) ?? pane()) !== "sources")
      showPane(() => setPane("sources"));
    history.pushState(
      withDiscovery(withDashboardPane(history.state, "sources"), true),
      "",
    );
    setDiscovery(true);
  };
  // Set while a close steps Back through Discover's entries: each preview
  // article it opened on a phone pushed one more. Those steps change
  // nothing on screen, since Discover is already gone.
  let leavingDiscovery: (() => void) | undefined;
  // Closes at once, and settles once history is back on the entry Discover
  // opened over, so a pane switch that follows is not the one Back undoes.
  const closeDiscovery = () => {
    setDiscovery(false);
    if (!isDiscoveryEntry(history.state)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      leavingDiscovery = resolve;
      history.back();
    });
  };
  const popstate = (event: PopStateEvent) => {
    const inDiscovery = isDiscoveryEntry(event.state);
    if (leavingDiscovery) {
      if (inDiscovery) {
        history.back();
        return;
      }
      leavingDiscovery();
      leavingDiscovery = undefined;
    }
    showPane(() => {
      setPath(currentPath());
      setPane(parseDashboardPane(event.state) ?? "sources");
      setDiscovery(inDiscovery);
    }, event.hasUAVisualTransition);
  };
  const route = () => resolveRoute(path());
  const loginRoute = () => {
    const current = route();
    return current.name === "login" ? current : undefined;
  };

  createEffect(
    () => {
      const title = ROUTE_TITLES[route().name];
      const base = title === "FeedFathom" ? title : `${title} · FeedFathom`;
      // The tab-title unread badge (#717). Only the dashboard produces a
      // count; elsewhere it reads whatever the last dashboard left behind,
      // and zero (badge hidden) once the dashboard is gone.
      const badge =
        unreadBadge.get() && unreadTotal() > 0 ? `(${unreadTotal()}) ` : "";
      return `${badge}${base}`;
    },
    (title) => {
      document.title = title;
    },
  );

  // Deferred past the first render (nothing was replaced yet). Pane changes
  // keep the same path, and setPath's === check means the signal doesn't
  // fire for them, so moving between panes never steals focus. Landing on
  // <main> rather than a heading works for every route without each page
  // needing its own focus target; the dashboard's own tree focus (see its
  // onSettled) runs later and wins where it applies.
  createEffect(
    path,
    () => {
      queueMicrotask(() => {
        const main = document.querySelector("main");
        if (!main) return;
        main.tabIndex = -1;
        main.focus();
      });
    },
    { defer: true },
  );
  onSettled(() => {
    addEventListener("popstate", popstate);
    return () => removeEventListener("popstate", popstate);
  });

  // The options route is the one page the document scrolls (its settings run
  // past a viewport, and a scroll trapped inside the centered column read as
  // a cut-off page); everywhere else body stays clipped because the
  // dashboard's panes scroll themselves. Leaving it also drops the page
  // scroll -- hidden overflow would otherwise trap the viewport wherever
  // the options page left it.
  createEffect(
    () => route().name,
    (name) => {
      dataset["route"] = name;
      if (name !== "options") window.scrollTo(0, 0);
    },
  );

  return (
    <>
      <a
        class="skip-link"
        href="/options"
        onClick={(event) => {
          event.preventDefault();
          navigate("/options");
        }}
      >
        Skip to accessibility settings
      </a>
      <DialogHost />
      <Show when={offlineChangeLost()}>
        <div class="app-alert" role="alert">
          <p>
            A change made while offline could not be applied and was discarded.
            Reload to see the current state.
          </p>
          <button
            class="button-primary"
            type="button"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        </div>
      </Show>
      {/* A lazy route's chunk fails to load offline before its first visit,
          or after a deploy removed the old build's chunks. */}
      <Errored
        fallback={
          <main>
            <p>This page could not load. Check your connection.</p>
            <button type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </main>
        }
      >
        <Loading>
          <Show
            when={loginRoute()}
            fallback={
              <Router
                route={route()}
                navigate={navigate}
                handleUnauthorized={handleUnauthorized}
                pane={pane}
                focusPane={focusPane}
                backPane={backPane}
                discovery={discovery}
                openDiscovery={openDiscovery}
                closeDiscovery={closeDiscovery}
                whenPaneShown={whenPaneShown}
              />
            }
          >
            {(login) => <Login navigate={navigate} next={login().next} />}
          </Show>
        </Loading>
      </Errored>
    </>
  );
}

function Router(props: {
  backPane(): void;
  closeDiscovery(): Promise<void>;
  discovery(): boolean;
  focusPane(next: DashboardPane): void;
  handleUnauthorized(cause: unknown): boolean;
  navigate(to: string): void;
  openDiscovery(): void;
  pane(): DashboardPane;
  route: Route;
  whenPaneShown(run: () => void): void;
}) {
  // A memo rather than an inline ternary: the Dashboard reads this prop
  // from onSettled and event handlers, where an inline conditional's
  // per-read memo would be created outside any owner.
  const preview = createMemo(() =>
    props.route.name === "preview" ? props.route : undefined,
  );
  return (
    <Show
      when={showsPanes(props.route)}
      fallback={
        <Switch>
          <Match
            when={props.route.name === "register" ? props.route : undefined}
          >
            {(route) => (
              <Register next={route().next} navigate={props.navigate} />
            )}
          </Match>
          <Match
            when={props.route.name === "activate" ? props.route : undefined}
          >
            {(route) => (
              <Activate token={route().token} navigate={props.navigate} />
            )}
          </Match>
          <Match when={props.route.name === "passwordReset"}>
            <PasswordReset navigate={props.navigate} />
          </Match>
          <Match
            when={
              props.route.name === "passwordResetConfirm"
                ? props.route
                : undefined
            }
          >
            {(route) => (
              <PasswordResetConfirm
                token={route().token}
                navigate={props.navigate}
              />
            )}
          </Match>
          <Match when={props.route.name === "options"}>
            <Options
              handleUnauthorized={props.handleUnauthorized}
              navigate={props.navigate}
            />
          </Match>
          <Match when={props.route.name === "notFound"}>
            <main>
              <section class="account-result">
                <h1>Page not found</h1>
                <p>There is nothing at this address.</p>
                <a
                  href="/"
                  onClick={(event) => {
                    event.preventDefault();
                    props.navigate("/");
                  }}
                >
                  Home
                </a>
              </section>
            </main>
          </Match>
          <Match when={props.route.name === "admin"}>
            <Admin
              handleUnauthorized={props.handleUnauthorized}
              navigate={props.navigate}
            />
          </Match>
        </Switch>
      }
    >
      <Dashboard
        navigate={props.navigate}
        handleUnauthorized={props.handleUnauthorized}
        pane={props.pane}
        focusPane={props.focusPane}
        backPane={props.backPane}
        discovery={props.discovery}
        openDiscovery={props.openDiscovery}
        closeDiscovery={props.closeDiscovery}
        whenPaneShown={props.whenPaneShown}
        preview={preview()}
      />
    </Show>
  );
}

if ("serviceWorker" in navigator) {
  // bin/build-spa.ts bundles the worker and names it for a production build.
  // Vite's dev server serves the source as a module instead, which only
  // Chromium-based browsers register.
  const builtWorkerPath: string | undefined = import.meta.env[
    "VITE_SW_FILENAME"
  ];
  const workerPath = builtWorkerPath ?? "/sw.ts";
  // A new deploy is applied the next time the page is hidden, so the user
  // comes back to it without a prompt. By then the worker has cached the new
  // shell with its assets, so the reload is served from cache.
  let updatePending = false;
  const markUpdatePending = () => {
    updatePending = true;
  };
  // Fields typed into since their form last submitted. A form that unmounts
  // unsent takes its fields out of the document, so it stops counting.
  const editedFields = new Set<Element>();
  document.addEventListener("input", (event) => {
    if (event.target instanceof Element && event.target.closest("form"))
      editedFields.add(event.target);
  });
  document.addEventListener(
    "submit",
    (event) => {
      for (const field of editedFields)
        if (event.target instanceof Node && event.target.contains(field))
          editedFields.delete(field);
    },
    true,
  );
  const hasUnsavedInput = () =>
    isDialogOpen() || [...editedFields].some((field) => field.isConnected);
  document.addEventListener("visibilitychange", () => {
    if (updatePending && document.hidden && !hasUnsavedInput())
      reloadForUpdate();
  });
  // A page whose bundle already names the controlling worker sees a later
  // controllerchange only from a newer deploy. A page loaded from a new shell
  // under the previous worker is waiting for exactly the worker it registers,
  // so that takeover is no update.
  const controllerUrl = navigator.serviceWorker.controller?.scriptURL;
  if (controllerUrl && new URL(controllerUrl).pathname === workerPath)
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      markUpdatePending,
    );
  // The worker serves a cached shell first and reports when the server's
  // shell names different assets, which a bundle-only deploy never signals
  // through controllerchange.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (!isWorkerMessage(event.data)) return;
    switch (event.data.type) {
      case "shell-updated":
        markUpdatePending();
        break;
      case "queued-mutation-failed":
        setOfflineChangeLost(true);
        break;
    }
  });
  void navigator.serviceWorker.register(workerPath, {
    type: builtWorkerPath ? "classic" : "module",
  });
}

installDeleteTrace();
render(() => <App />, document.querySelector("#app")!);
