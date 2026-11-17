# Upcoming major upgrades: Bun 1.4, Elysia 2.0, Solid 2.0

Researched 2026-08-16, versions rechecked 2026-09-07; Solid rows 2026-11-17.

| Package           | We use       | `latest` | `next` / prerelease |
| ----------------- | ------------ | -------- | ------------------- |
| bun               | 1.4.4        | 1.4.4    | —                   |
| elysia            | 2.0.0-rc.0   | 1.4.30   | 2.0.0-rc.0          |
| solid-js          | 2.0.0        | 2.0.0    | —                   |
| @solidjs/vite-plugin | 3.0.1     | 3.0.1    | —                   |
| typebox           | 1.4.2        | 1.4.2    | —                   |

`npm-check-updates` resolves elysia to its `experimental` dist-tag
(`2.0.0-exp.64`), which is a different line from the `next` beta the project
is on. Bumping elysia is a deliberate edit, not something to accept from
`ncu -u`.

## Bun 1.4

Released, and we're on it — 1.4.4 as of 2026-10-22. The version is pinned in
three places: `packageManager` (CI reads this via `oven-sh/setup-bun`'s
`bun-version-file`), `devDependencies["bun-types"]`, and 4 `oven/bun:` tags in
the `Dockerfile`. All three move together, and the suite is run against a
matching binary before the pin lands: a Bun release has changed test outcomes
in this repo before, so bumping the pin without running on it is not a bump,
it is a guess.

The headline for us is `Bun.XML` — a native SIMD XML parser and serializer
that replaces `fast-xml-parser`. See "XML parsing" below.

## Elysia 2.0

Already migrated — the codebase is on the 2.0 beta and uses the new API
throughout: `.onError(Class, fn)` instead of code-based `onError`, `.derive("plugin", …)`
instead of `resolve`, `typebox` 1.x instead of `@sinclair/typebox` 0.34. The
codemod (`bunx @elysia/codemod@latest`) has nothing left to do here.

Remaining work is a version bump when 2.0.0 goes stable: change the pin to
`^2.0.0`. Until then keep an exact prerelease pin rather than the `next` tag,
so a new release can't land unreviewed on a fresh install — moved beta.4 to
beta.14 on 2026-09-07 with no source changes, and beta.14 to rc.0 on
2026-10-19. The RC renamed the beta's short hooks back to `onRequest`,
`onAfterResponse` and `onError`, and those hooks now reach only routes
registered after them, so `server-app.ts` registers them before its `.use()`
calls.

Worth evaluating once stable, both opt-in and both currently unused here:

- **AOT compilation** — move route compilation to build time via the Bun.build
  plugin. Cuts startup; matters for container cold starts, not much else.
- **`defer`** — run work after the response flushes. Would suit the
  fire-and-forget paths that today call `.catch(console.error)` on a floating
  promise.

## Solid 2.0

Done: `solid-js` and `@solidjs/web` 2.0.0, built by `@solidjs/vite-plugin`
3.0.1 (the renamed `vite-plugin-solid`), since 2026-11-17. Solid 2.0 went
stable on 2026-11-16 ("The Long Hold" release post); the plugin's 3.0
release the next day ended the toolchain mismatch that blocked this.

The type checker caught the API changes: split `createEffect`,
`onMount` → `onSettled`, `classList` → `class` arrays and objects, no `on()`,
`createSelector` → `createProjection`, `Suspense`/`ErrorBoundary` →
`Loading`/`Errored`, lowercase `tabindex`/`readonly`, and the `JSX` types
moving to `@solidjs/web`. What follows is what it did not catch. The browser
suite runs on the Vite dev server, where Solid 2.0 reports these as coded
diagnostics; it passes with none.

**Writes are deferred.** A setter queues its write: the signal, every memo
over it, and the DOM keep the old value until Solid's next flush, a
microtask later. Code that sets a signal and then reads it, directly or
through a helper, sees the old value. The migration fixed 13 such sites, and
the fixes take three forms:

- Pass the value just computed instead of re-reading it (`selectRows(…,
  rows)`, `load(column, direction)` in `admin.tsx`).
- Call `flush()` after the write, in an event handler or after an `await`.
  It throws inside `onSettled` and does nothing in an effect's apply phase.
- Keep a plain field beside the signal for synchronous checks
  (`SessionRestore`).

Focus that waits for a pane to show goes through `whenPaneShown`, which
queues a microtask behind the flush.

**Inline conditional props make a memo on every read.** A prop given a
ternary or `&&` expression compiles to a getter that creates a memo. Reading
it inside `onSettled` or an effect's apply phase throws
(`PRIMITIVE_IN_FORBIDDEN_SCOPE`, `PRIMITIVE_IN_EFFECT_CALLBACK`). Give such a
prop a memo at the call site (`preview` in `main.tsx`, `editedSource` in
`dashboard.tsx`).

**Reads outside a tracking scope warn.** A component body, a `<For>`/`<Show>`
callback body, and an effect's apply phase do not track. A read there that is
meant to happen once goes in `untrack()`. A read that should re-run something
belongs in an effect's compute function.

**Boolean attributes are presence or absence.** `aria-expanded={false}`
removes the attribute. ARIA states take the strings `"true"`/`"false"`.

**A `value` binding re-applies whenever its element's other bindings
change.** An input whose `value` is not written on every `onInput` loses what
the user typed. `PasswordInput` therefore requires `value`.

The shared runtime chunk grew from 33 KB to 88 KB minified (+21 KB gzipped
across the SPA). No dev diagnostics leak into it: this is the 2.0 runtime
itself.

## XML parsing: on `Bun.XML`

Both XML paths run on Bun 1.4's native parser. `fast-xml-parser` and its 6
transitive dependencies are gone.

- **OPML** — `src/features/feeds/xml.ts` wraps `Bun.XML`'s compact shape; `OpmlParser`
  uses it. `Bun.XML` throws on malformed input, so the separate `XMLValidator`
  pass is no longer needed.
- **Feeds** — `vendor/fast-xml-parser-shim` stands in for the package itself,
  reimplementing the only two things `@rowanmanning/feed-parser` uses
  (`XMLParser` in `preserveOrder` mode, `XMLBuilder` for `innerHtml`) on
  `Bun.XML`'s ordered tree shape. Same arrangement as `vendor/linkedom-shim`.

**The `overrides` entry is load-bearing, for both shims.** `feed-parser`
depends on `fast-xml-parser@^5.10.1`, which a `file:` spec does not satisfy,
so the dependency alone leaves bun installing the real package nested under
`feed-parser` and the shim silently bypassed.

`linkedom` learned this the expensive way. It had the direct dependency and a
patchfile stripping `linkedom` from `@extractus/article-extractor`'s own
dependencies, but no override. `patchedDependencies` keys carry an exact
version, so bumping `^9.0.0` to `^9.0.1` stopped the patch applying without a
word, bun installed the real 2.6 MB package nested, and the SPA bundle grew
from 340 KB to 529 KB. It now has an override and no patchfile.

The linkedom shim is also no longer purely standard API. `article-extractor`
9.0.1 replaced its `sanitize-html` pass with a hand-rolled walk over
`doc.documentElement.childNodes` and serializes back through `doc.childNodes`,
and those two are where the browser and linkedom disagree: handed a fragment,
linkedom roots the document at the fragment itself, while the browser always
synthesizes `<html><head><body>`. Under the native parser the walk deleted
head and body -- neither is an allowed tag -- and every extraction came back
null. The shim now hands back a fragment-rooted view of the document for that
case. `tests/browser/spa.spec.ts` "extracts article content with the alternate
extractor" is the check; it needs a real DOM, so it cannot live beside the
other shim tests.

`vendor/__tests__/shim-fidelity.test.ts` checks both, on every run: no nested
copy of either package, the installed one is the vendored one, and every name
the dependent imports is a name the shim exports. That last part is the
`ncu -u` alarm -- a bump reaching for an unimplemented shim API otherwise
fails only at runtime, on whichever feed happens to need it.

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

That cost nothing on the production feeds, but it did on feeds nobody had
subscribed to yet: 7 of 675 public feeds (1.0%) failed, on a bare `&`,
whitespace before `<?xml`, a `<script>` after the root, or a control
character. An OPML export with `&nbsp;` or a bare `&` failed the whole
import. `parseRepairingXml` in `src/features/feeds/xml.ts` now retries a
rejected feed or OPML document once after repairing exactly those defects;
see [the feed parser research note](research/feed-parser-libraries.md).
Broken structure (mismatched or missing end tags) still fails.

`Bun.XML.parse` takes one option, `compact`. Other keys are accepted silently
and ignored, so treat the output shape as fixed.

## Done on this branch

- Removed `@sinclair/typebox` 0.34 — a dead dependency since the Elysia 2 move
  to standalone `typebox`, nothing imports it (it was in knip's ignore list,
  which is now gone too).
- Pinned `elysia` to an exact prerelease (now `2.0.0-rc.0`) instead of the
  floating `next` tag.
- Removed the hand-run `Value.Decode()` calls from the route handlers. Every
  2.0 prerelease from beta.1 on decodes Codec fields in `body`, `query` and
  `params` before the handler runs, so the handlers decoded a second time.
- Replaced `fast-xml-parser` with `Bun.XML` on both the OPML and feed paths.
