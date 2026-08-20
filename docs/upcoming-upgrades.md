# Upcoming major upgrades: Bun 1.4, Elysia 2.0, Solid 2.0

Researched 2026-08-16, Bun section updated 2026-08-20 when 1.4.0 shipped.

| Package           | We use       | `latest` | `next` / prerelease |
| ----------------- | ------------ | -------- | ------------------- |
| bun               | 1.4.0        | 1.4.0    | —                   |
| elysia            | 2.0.0-beta.4 | 1.4.29   | 2.0.0-beta.4        |
| solid-js          | 1.9.14       | 1.9.14   | 2.0.0-rc.0          |
| vite-plugin-solid | 2.11.14      | 2.11.14  | 3.0.0-next.27       |
| typebox           | 1.3.9        | 1.3.14   | —                   |

## Bun 1.4

Released, and we're on it. The version is pinned in three places, all bumped
to `1.4.0`: `packageManager` (CI reads this via `oven-sh/setup-bun`'s
`bun-version-file`), `devDependencies["bun-types"]`, and 4 `dhi.io/bun:` tags
in the `Dockerfile`.

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
small — five `.tsx` files, and only these imports:

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
12 sites: `dashboard.tsx` (266, 288, 882, 961, 1039, 1072, 1114),
`feed-discovery.tsx` (256, 387, 409, 428), `options-admin.tsx` (466).

```jsx
// now
<div class="card" classList={{ active: isActive() }} />
// 2.0
<div class={["card", { active: isActive() }]} />
```

**`createEffect` splits into compute → apply** — 2 sites (`main.tsx:36`,
`dashboard.tsx:400`).

```js
createEffect(() => { document.documentElement.dataset.theme = resolvedTheme(); });
// 2.0
createEffect(resolvedTheme, (theme) => { document.documentElement.dataset.theme = theme; });
```

**`onMount` → `onSettled`, `onCleanup` folds into the returned cleanup** —
7 `onMount` and 4 `onCleanup` calls. The paired ones (`main.tsx:72-73`,
`feed-discovery.tsx:79/84`, `dashboard.tsx`, `account-flows.tsx:127/142`)
collapse into one call:

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
4. `createEffect` split (2 sites).
5. Re-run the read-after-set audit — the scan is a `createSignal` regex plus a
   7-line lookahead for a matching read; it caught the one real case here.

## XML parsing

`src/lib/xml.ts` is a thin shim over `Bun.XML`, and `OpmlParser` is the only
thing that uses it -- OPML import was our sole direct XML parse. Feed XML is
*not* ours to move: it goes through `@rowanmanning/feed-parser`, which depends
on `fast-xml-parser` itself, so that package stays in the tree as a transitive
dependency.

`Bun.XML.parse` differs from our old `fast-xml-parser` configuration in four
ways, which is what the shim exists to absorb:

| | fast-xml-parser (as configured) | `Bun.XML` |
| --- | --- | --- |
| Attributes | grouped under `@_`, unprefixed | inline on the element, `@`-prefixed |
| Repeated elements | forced to arrays via `isArray` | array only when >1; a lone child is an object |
| Empty element | `{}` | `""` |
| Malformed input | silent; needed a separate `XMLValidator` pass | `parse` throws |

That last one let us drop `XMLValidator` and the separate validation pass
entirely. Options passed as a second argument to `parse` appear to be ignored
(unknown keys are accepted silently and change nothing), so the output shape
is fixed -- treat it as non-configurable.

Verified on Bun 1.4.0: all 20 OPML parser tests pass, including the 7
raw-XML `parse-opml` fixtures which were not modified.

## Done on this branch

- Removed `@sinclair/typebox` 0.34 — a dead dependency since the Elysia 2 move
  to standalone `typebox`, nothing imports it (it was in knip's ignore list,
  which is now gone too).
- Pinned `elysia` to `2.0.0-beta.4` instead of the floating `next` tag.
- Fixed the one Solid-2.0-hostile read-after-set in `dashboard.tsx`.
- Moved to Bun 1.4.0 and replaced `fast-xml-parser` with a `Bun.XML` shim.
