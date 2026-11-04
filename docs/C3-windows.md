# C3: tabs instead of windows, bounded fill

Branch `fix/c3-tabs-not-windows`, based on `agstudio/native-video` after the
v1.18.1 sync.

## Tabs, not windows

Firefox prefs at launch: `browser.link.open_newwindow=3` and
`browser.link.open_newwindow.restriction=0`. The first page in a context still
uses `context.newPage()` (there is no window to attach to yet). Every later page
in the same context uses `existingPage.evaluate(() => window.open("about:blank"))`
plus `context.waitForEvent("page")`, so Firefox applies its own tab policy and
the page becomes a tab of the existing window. `GET /tabs` now exposes
`contextId`, so a test can prove two tabs share one context.

Creation is serialised per context. The first `context.newPage()` is an
about:blank ANCHOR tab we own; it is never navigated, never returned to a
caller and never counted as a tab. Every user page, including the first, is
opened from that anchor with a unique window name and `noopener`. No
window.open ever runs in a page the site controls. The new page's name is
checked before it is used, so concurrent creations cannot receive each other's
page, and the opener is null before any site code runs. If the anchor dies it
is recreated with `context.newPage()`.

Headful trace with `CAMOFOX_TRACE_WINDOWS=1`, three concurrent cold
`POST /tabs` for one new user (page-3 is the anchor and is not a managed tab):

```json
{"event":"context_created","contextId":"ctx-2","reason":"session-create","userId":"cold"}
{"event":"page_created","pageId":"page-3","contextId":"ctx-2","reason":"anchor","openedVia":"newPage"}
{"event":"page_created","pageId":"page-4","contextId":"ctx-2","reason":"tab","openedVia":"window.open"}
{"event":"page_created","pageId":"page-5","contextId":"ctx-2","reason":"tab","openedVia":"window.open"}
{"event":"page_created","pageId":"page-6","contextId":"ctx-2","reason":"tab","openedVia":"window.open"}
```

Firefox window count from `System Events`: 0 before any tab, 1 after one tab,
0 after closing that session, and 1 after three concurrent cold tabs for one
new user. `/health` reported `windows:1`, `activeTabs:3`; the three tabs shared
`ctx-2`. The page screenshot reported real dimensions `1728x999`.

Background-tab check: after opening a second tab, `document.visibilityState`
stayed `visible`, `document.hidden` stayed `false`, and `requestAnimationFrame`
ticked 61 times in 1 s both headless and headful. No bringToFront change was
needed.

## Item status

1. Tabs not windows: `lib/tab-pages.js` plus launch prefs, an owned about:blank
   anchor tab, per-context serialisation and unique window names. Unit test
   `tests/unit/tabPages.test.js`; headful trace and window counts above.
2. Click/fill fallback: already fixed by the v1.18.1 sync. Click on Wikipedia
   `#searchInput` took 2.0 s and never entered the mouse fallback; its mouse
   calls are bounded by the remaining handler budget in `server.js`.
3. Dedicated tab DELETE/listing: already fixed by the sync. DELETE finalizes and
   closes the context, `GET /tabs` includes dedicated tabs. E2E
   `tests/e2e/c3Tabs.test.js`.
4. Screenshot dimensions: `lib/image-size.js` parses PNG/JPEG, the route sets
   `X-Screenshot-Width/Height`, and `?meta=1` returns JSON with the real size.
5. Headful idle default: `BROWSER_IDLE_TIMEOUT_MS` defaults to 0 when
   `CAMOFOX_HEADFUL=true`. Config test.
6. Concurrent cold `POST /tabs`: `coalesceInflight` already covers it; the e2e
   test asserts both tabs share one `contextId`.
7. Wikipedia fill: `assertLocatorFillable` called `locator.evaluate()` without a
   timeout, inheriting Playwright's 30 s default. `lib/fill.js` bounds the probe
   to 5 s and selector fills use `.first()`. Wikipedia `#searchInput` now fills
   in 0.5 s. A popup login-like flow (child posts a message back and closes)
   also works as a tab; e2e covers it.
8. `GET /tabs` without `userId` is a 400. Bureau's camofox client always passes
   `userId`, so nothing needs the all-users listing. E2E test.
9. LinkedIn interstitial: navigate does a single `goto` (`waitUntil: commit`)
   followed by a domcontentloaded wait; it does not reload, run a login-wall
   check, or auto-click. Google/Amazon are the only special navigation paths.
   So the fork should not interrupt the self-redirect, but navigate can return
   at the first domcontentloaded before the interstitial finishes, so an
   immediate snapshot may still show the interstitial. No LinkedIn-specific
   server code was added.
