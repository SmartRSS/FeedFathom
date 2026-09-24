import {
  createEffect,
  createSignal,
  ErrorBoundary,
  lazy,
  Match,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
} from "solid-js";
import { render } from "solid-js/web";
import {
  loginPath,
  parseDashboardPane,
  resolveRoute,
  withDashboardPane,
  type DashboardPane,
  type Route,
} from "./behavior.ts";
import { Dashboard } from "./dashboard.tsx";
import { DialogHost } from "./dialog.tsx";
import { isUnauthorizedError } from "./api.ts";
import {
  mobileListAnchor,
  readerText,
  readerWidth,
  resolvedTheme,
} from "./preferences.ts";
import { unreadBadgeEnabled, unreadTotal } from "./news-signal.ts";
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
  options: "Options",
  passwordReset: "Reset password",
  passwordResetConfirm: "Reset password",
  preview: "Discover feed",
  register: "Register",
};

const currentPath = () => location.pathname + location.search;
const backPane = () => history.back();
const [updateAvailable, setUpdateAvailable] = createSignal(false);

function App() {
  const initialPath = currentPath();
  const initialRoute = resolveRoute(initialPath);
  const [path, setPath] = createSignal(initialPath);
  const [pane, setPane] = createSignal<DashboardPane>("sources");

  createEffect(() => {
    document.documentElement.dataset["theme"] = resolvedTheme();
  });
  // On the same element as the theme, so the reader rules can key off either
  // without a second host to reason about. One effect each rather than one
  // for both: each attribute follows exactly one signal, which is the shape
  // Solid 2.0's compute-then-apply split wants (docs/upcoming-upgrades.md).
  createEffect(() => {
    document.documentElement.dataset["readerText"] = readerText();
  });
  createEffect(() => {
    document.documentElement.dataset["readerWidth"] = readerWidth();
  });
  createEffect(() => {
    document.documentElement.dataset["mobileListAnchor"] = mobileListAnchor();
  });

  if (initialRoute.name === "dashboard" || initialRoute.name === "preview")
    history.replaceState(withDashboardPane(history.state, "sources"), "");

  const navigate = (to: string) => {
    const nextRoute = resolveRoute(to);
    const nextPane =
      nextRoute.name === "dashboard" || nextRoute.name === "preview"
        ? "sources"
        : undefined;
    history.pushState(nextPane ? withDashboardPane({}, nextPane) : {}, "", to);
    setPath(to);
    setPane(nextPane ?? "sources");
  };
  const handleUnauthorized = (cause: unknown) => {
    if (!isUnauthorizedError(cause)) return false;
    navigate(loginPath(currentPath()));
    return true;
  };
  const focusPane = (next: DashboardPane) => {
    if (next === pane()) return;
    history.pushState(withDashboardPane(history.state, next), "");
    setPane(next);
  };
  const popstate = (event: PopStateEvent) => {
    setPath(currentPath());
    setPane(parseDashboardPane(event.state) ?? "sources");
  };
  const route = () => resolveRoute(path());
  const loginRoute = () => {
    const current = route();
    return current.name === "login" ? current : undefined;
  };

  createEffect(() => {
    const title = ROUTE_TITLES[route().name];
    const base = title === "FeedFathom" ? title : `${title} · FeedFathom`;
    // The tab-title unread badge (#717). Only the dashboard produces a
    // count; elsewhere it reads whatever the last dashboard left behind,
    // and zero (badge hidden) once the dashboard is gone. The signal holds
    // "on"/"off" strings -- "off" is truthy, so compare it explicitly
    // (the bare && read it as always-on: #765).
    const badge =
      unreadBadgeEnabled() === "on" && unreadTotal() > 0
        ? `(${unreadTotal()}) `
        : "";
    document.title = `${badge}${base}`;
  });

  // Skips the first render (nothing was replaced yet). Pane changes keep the
  // same path, and setPath's === check means the signal doesn't fire for
  // them, so moving between panes never steals focus. Landing on <main>
  // rather than a heading works for every route without each page needing
  // its own focus target; the dashboard's own tree focus (see its onMount)
  // runs later and wins where it applies.
  let firstRoute = true;
  createEffect(() => {
    path();
    if (firstRoute) {
      firstRoute = false;
      return;
    }
    queueMicrotask(() => {
      const main = document.querySelector("main");
      if (!main) return;
      main.tabIndex = -1;
      main.focus();
    });
  });
  onMount(() => addEventListener("popstate", popstate));
  onCleanup(() => removeEventListener("popstate", popstate));

  // The options route is the one page the document scrolls (its settings run
  // past a viewport, and a scroll trapped inside the centered column read as
  // a cut-off page); everywhere else body stays clipped because the
  // dashboard's panes scroll themselves. Leaving it also drops the page
  // scroll -- hidden overflow would otherwise trap the viewport wherever
  // the options page left it.
  createEffect(() => {
    const name = route().name;
    document.documentElement.dataset["route"] = name;
    if (name !== "options") window.scrollTo(0, 0);
  });

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
      {/* One dialog host for every confirm()/prompt() replacement (#698). */}
      <DialogHost />
      <Show when={updateAvailable()}>
        <div class="update-banner" role="status">
          <span>A new version is available.</span>
          <button type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </Show>
      {/* A lazy route's chunk fails to load offline before its first visit,
          or after a deploy removed the old build's chunks. */}
      <ErrorBoundary
        fallback={
          <main>
            <p>This page could not load. Check your connection.</p>
            <button type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </main>
        }
      >
        <Suspense>
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
              />
            }
          >
            {(login) => <Login navigate={navigate} next={login().next} />}
          </Show>
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

function Router(props: {
  backPane(): void;
  focusPane(next: DashboardPane): void;
  handleUnauthorized(cause: unknown): boolean;
  navigate(to: string): void;
  pane(): DashboardPane;
  route: Route;
}) {
  return (
    <Show
      when={props.route.name === "dashboard" || props.route.name === "preview"}
      fallback={
        <Switch>
          <Match when={props.route.name === "register" && props.route}>
            {(route) =>
              route().name === "register" && (
                <Register next={route().next} navigate={props.navigate} />
              )
            }
          </Match>
          <Match when={props.route.name === "activate" && props.route}>
            {(route) =>
              route().name === "activate" && (
                <Activate token={route().token} navigate={props.navigate} />
              )
            }
          </Match>
          <Match when={props.route.name === "passwordReset"}>
            <PasswordReset navigate={props.navigate} />
          </Match>
          <Match
            when={props.route.name === "passwordResetConfirm" && props.route}
          >
            {(route) =>
              route().name === "passwordResetConfirm" && (
                <PasswordResetConfirm
                  token={route().token}
                  navigate={props.navigate}
                />
              )
            }
          </Match>
          <Match when={props.route.name === "options"}>
            <Options
              handleUnauthorized={props.handleUnauthorized}
              navigate={props.navigate}
            />
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
        initialDiscovery={props.route.name === "preview"}
        initialFeedUrl={
          props.route.name === "preview" ? props.route.feedUrl : undefined
        }
      />
    </Show>
  );
}

if ("serviceWorker" in navigator) {
  // A replacement worker can differ from the loaded JS bundle. Offer a reload
  // rather than interrupting the session. Notifications are enabled only if
  // the page has a controller when this listener is registered.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    setUpdateAvailable(true);
  });
  // The worker serves a cached shell first and reports when the server's
  // shell names different assets, which a bundle-only deploy never signals
  // through controllerchange.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (
      data &&
      typeof data === "object" &&
      "type" in data &&
      data.type === "shell-updated"
    )
      setUpdateAvailable(true);
  });
  // Falls back to the unhashed dev filename: bin/build-spa.ts only injects
  // VITE_SW_FILENAME for production builds, and Vite's dev server serves
  // public/ files at their literal path anyway.
  void navigator.serviceWorker.register(
    import.meta.env["VITE_SW_FILENAME"] ?? "/sw.js",
  );
}

render(() => <App />, document.querySelector("#app")!);
