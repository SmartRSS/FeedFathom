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
import { ApiError, isUnauthorizedError } from "./api.ts";
import { accountMismatchStatus } from "#shared/contracts/headers.ts";
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

const [offlineChangeLost, setOfflineChangeLost] = createSignal(false);

const currentPath = () => location.pathname + location.search;
const backPane = () => history.back();
const paneSwitchHost: PaneSwitchHost = {
  matches: (query) => matchMedia(query).matches,
  startViewTransition:
    "startViewTransition" in document
      ? (update) => {
          const transition = document.startViewTransition(update);
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

  if (showsPanes(initialRoute))
    history.replaceState(
      withDiscovery(withDashboardPane(history.state, "sources"), false),
      "",
    );

  const navigate = (to: string) => {
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
    if (cause instanceof ApiError && cause.status === accountMismatchStatus) {
      location.reload();
      return true;
    }
    if (!isUnauthorizedError(cause)) return false;
    navigate(loginPath(currentPath()));
    return true;
  };
  let paneShown: Promise<void> | undefined;
  const showPane = (update: () => void, browserAnimated?: boolean) => {
    const shown = switchPane(update, paneSwitchHost, browserAnimated);
    paneShown = shown;
    void shown?.then(() => {
      if (paneShown === shown) paneShown = undefined;
    });
  };
  const whenPaneShown = (run: () => void) => {
    if (paneShown) void paneShown.then(run);
    else queueMicrotask(run);
  };
  const focusPane = (next: DashboardPane) => {
    if (next === (parseDashboardPane(history.state) ?? pane())) return;
    history.pushState(withDashboardPane(history.state, next), "");
    showPane(() => setPane(next));
  };
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
  let leavingDiscovery: (() => void) | undefined;
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
      const badge =
        unreadBadge.get() && unreadTotal() > 0 ? `(${unreadTotal()}) ` : "";
      return `${badge}${base}`;
    },
    (title) => {
      document.title = title;
    },
  );

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

  createEffect(
    () => route().name,
    (name) => {
      if (name !== "options") window.scrollTo(0, 0);
      dataset["route"] = name;
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
  const builtWorkerPath: string | undefined = import.meta.env[
    "VITE_SW_FILENAME"
  ];
  const workerPath = builtWorkerPath ?? "/sw.ts";
  let updatePending = false;
  const markUpdatePending = () => {
    updatePending = true;
  };
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
  const controllerUrl = navigator.serviceWorker.controller?.scriptURL;
  if (controllerUrl && new URL(controllerUrl).pathname === workerPath)
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      markUpdatePending,
    );
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
