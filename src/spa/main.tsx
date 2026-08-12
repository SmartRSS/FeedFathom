import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
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
} from "./behavior";
import { Activate, Login, Register } from "./account-flows";
import { Dashboard } from "./dashboard";
import { Admin, Options } from "./options-admin";
import { isUnauthorizedError } from "./api";
import { resolvedTheme } from "./preferences";
import "./style.css";

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
  onMount(() => addEventListener("popstate", popstate));
  onCleanup(() => removeEventListener("popstate", popstate));

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
      <Show when={updateAvailable()}>
        <div class="update-banner" role="status">
          <span>A new version is available.</span>
          <button type="button" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </Show>
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
  // The new worker calls clients.claim() on activate, so an already-open tab
  // can end up with its fetches controlled by a worker version its already-
  // loaded JS bundle doesn't match. Surface it instead of forcing a reload
  // mid-session -- but only when a controller is being *replaced*: a page's
  // first-ever controllerchange (going from uncontrolled to controlled)
  // fires too, and that one needs no prompt since nothing's changed yet.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
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
