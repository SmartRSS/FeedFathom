# Upcoming major upgrades: Bun 1.4, Elysia 2.0, Solid 2.0

Researched 2026-08-16, Bun section updated 2026-09-04 for 1.4.1.

| Package           | We use       | `latest` | `next` / prerelease |
| ----------------- | ------------ | -------- | ------------------- |
| bun               | 1.4.1        | 1.4.1    | —                   |
| elysia            | 2.0.0-beta.4 | 1.4.29   | 2.0.0-beta.4        |
| solid-js          | 1.9.15       | 1.9.15   | 2.0.0-rc.0          |
| vite-plugin-solid | 2.11.14      | 2.11.14  | 3.0.0-next.27       |
| typebox           | 1.3.9        | 1.3.14   | —                   |

## Bun 1.4

Released, and we're on it — the bump landed on `main` separately. The version
is pinned in three places: `packageManager` (CI reads this via
`oven-sh/setup-bun`'s `bun-version-file`), `devDependencies["bun-types"]`, and
4 `oven/bun:` tags in the `Dockerfile`.

The headline for us is `Bun.XML` — a native SIMD XML parser and serializer
that replaces `fast-xml-parser`. See "XML parsing" below.

## Elysia 2.0

Already migrated — the codebase is on the 2.0 beta and uses the new API
throughout: `.error(Class, fn)` instead of code-based `onError`, `.derive("plugin", …)`
instead of `resolve`, `typebox` 1.x instead of `@sinclair/typebox` 0.34. The
codemod (`bunx @elysia/codemod@latest`) has nothing left to do here.

Remaining work is a version bump when 2.0.0 goes stable: change the pin to
`^2.0.0`. Until then keep an exact beta pin rather than the `next` tag, so a
new beta can't land unreviewed on a fresh install.

Worth evaluating once stable, both opt-in and both currently unused here:

- **AOT compilation** — move route compilation to build time via the Bun.build
  plugin. Cuts startup; matters for container cold starts, not much else.
- **`defer`** — run work after the response flushes. Would suit the
  fire-and-forget paths that today call `.catch(console.error)` on a floating
  promise.

## Solid 2.0

The real work. Solid 2.0 is a large breaking release, but our surface is
small — seven `.tsx` files import from Solid at all, and only these imports:

`createSignal`, `createEffect`, `For`, `Show`, `Switch`, `Match`, `onMount`,
`onCleanup`, `render`.

No stores, no `createResource`, no context, no `Index`, no `use:` directives,
no `Suspense`/`ErrorBoundary`, no `batch`, no `on()`, no `mergeProps`/`splitProps`.
Most of the migration guide simply doesn't apply.

### What breaks

**Imports and JSX source** — `solid-js/web` → `@solidjs/web`
(`src/spa/main.tsx:10`), and `tsconfig.json` `jsxImportSource` from `"solid-js"`
to `"@solidjs/web"`.

**`classList` is removed** — replaced by object/array forms of `class`.
12 sites: `dashboard.tsx` (5), `feed-discovery.tsx` (4), `tree-item.tsx` (2),
`admin.tsx` (1). Line numbers move; `grep -n classList src/spa/*.tsx` finds them.

```jsx
// now
<div class="card" classList={{ active: isActive() }} />
// 2.0
<div class={["card", { active: isActive() }]} />
```

**`createEffect` splits into compute → apply** — 4 sites (`main.tsx` ×3,
`dashboard.tsx` ×1).

```js
createEffect(() => { document.documentElement.dataset.theme = resolvedTheme(); });
// 2.0
createEffect(resolvedTheme, (theme) => { document.documentElement.dataset.theme = theme; });
```

**`onMount` → `onSettled`, `onCleanup` folds into the returned cleanup** —
7 `onMount` and 4 `onCleanup` calls. The paired ones (`main.tsx`,
`feed-discovery.tsx`, `dashboard.tsx`, `account-flows.tsx`) collapse into one
call:

```js
onMount(() => addEventListener("popstate", popstate));
onCleanup(() => removeEventListener("popstate", popstate));
// 2.0
onSettled(() => {
  addEventListener("popstate", popstate);
  return () => removeEventListener("popstate", popstate);
});
```

**Deferred setter visibility** — the silent one. Setters no longer change what
reads return until the microtask batch flushes (or `flush()` is called), so any
synchronous read-after-set in an event handler silently reads stale state.

Audited all 74 signals; one real site, already fixed on this branch:
`dashboard.tsx` read `tree()` right after `setTree(...)` to re-resolve the
selected node. Now computes the next tree once and uses that value for both.
The fix is correct under 1.9 as well, so it needs no follow-up at upgrade time.

### What does *not* break

- `<Show>` / `<Match>` function children already use the accessor form
  (`{(msg) => <p>{msg()}</p>}`) everywhere — that's the 2.0 signature.
- `<For>` keeps raw item values by default; only `keyed={false}` (the `Index`
  replacement) hands you an accessor, and we don't use `Index`.
- `<Switch>`/`<For>` otherwise unchanged.

### Blocker

`vite-plugin-solid` 3.x is still `next`-only (`3.0.0-next.27`). Wait for a
stable 3.0 before starting — the migration is mechanical enough that doing it
against a moving prerelease compiler buys nothing.

### Suggested order, when it's time

1. Bump `solid-js`, `@solidjs/web`, `vite-plugin-solid`; fix imports and
   `jsxImportSource`. Compile errors then map the rest.
2. `classList` → `class` (12 sites, purely mechanical).
3. `onMount`/`onCleanup` → `onSettled` (11 calls).
4. `createEffect` split (4 sites).
5. Re-run the read-after-set audit — the scan is a `createSignal` regex plus a
   7-line lookahead for a matching read; it caught the one real case here.

## XML parsing: on `Bun.XML`

Both XML paths run on Bun 1.4's native parser. `fast-xml-parser` and its 6
transitive dependencies are gone.

- **OPML** — `src/platform/xml.ts` wraps `Bun.XML`'s compact shape; `OpmlParser`
  uses it. `Bun.XML` throws on malformed input, so the separate `XMLValidator`
  pass is no longer needed.
- **Feeds** — `vendor/fast-xml-parser-shim` stands in for the package itself,
  reimplementing the only two things `@rowanmanning/feed-parser` uses
  (`XMLParser` in `preserveOrder` mode, `XMLBuilder` for `innerHtml`) on
  `Bun.XML`'s ordered tree shape. Same arrangement as `vendor/linkedom-shim`.

**The `overrides` entry is load-bearing.** `feed-parser` depends on
`fast-xml-parser@^5.10.1`, which a `file:` spec does not satisfy, so the
dependency alone leaves bun installing the real package nested under
`feed-parser` and the shim silently bypassed. Check
`node_modules/@rowanmanning/feed-parser/node_modules` is empty after any
dependency change.

### What it was measured against

The 229 sources in production (208 fetched): **204 parse, 0 regressions.** The
2 failures are HTML redirect pages rather than feeds, and `fast-xml-parser`
rejected them too. `feed-parser`'s own integration suite passes 1029/1029 on
the real package, and every shim failure traces to those same feeds.

13 feeds produce different output, 12 of them fixes. `fast-xml-parser` leaves
numeric character references encoded and `html-entities` does not catch them
downstream, so `palant.info` lost **every publication date** to a `&#43;` in
its timezone offset, and several feeds carried `&#038;` in image URLs. The
13th is a trailing newline, because `feed-parser` trims raw text before
decoding entities, so an encoded `&#xA;` used to survive the trim.

### The cost, and what to watch

`Bun.XML` is a conforming processor: well-formed or `SyntaxError`, no
recovery. `fast-xml-parser` was deliberately tolerant.

That did not cost anything on the feed corpus, but it is a real change for
OPML: an export containing an undeclared HTML entity (`&nbsp;`) or a bare `&`
in a title now fails the **whole import**, where before those outlines
imported fine. This has not been measured against real OPML uploads — the
`opml_imports` table in production is the place to check if imports start
failing.

`Bun.XML.parse` takes one option, `compact`. Other keys are accepted silently
and ignored, so treat the output shape as fixed.

## Done on this branch

- Removed `@sinclair/typebox` 0.34 — a dead dependency since the Elysia 2 move
  to standalone `typebox`, nothing imports it (it was in knip's ignore list,
  which is now gone too).
- Pinned `elysia` to `2.0.0-beta.4` instead of the floating `next` tag.
- Fixed the one Solid-2.0-hostile read-after-set in `dashboard.tsx`.
- Replaced `fast-xml-parser` with `Bun.XML` on both the OPML and feed paths.
