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

Headful trace with `CAMOFOX_TRACE_WINDOWS=1`, one user, two `POST /tabs`:

```json
{"event":"context_created","contextId":"ctx-1","reason":"session-create","userId":"main"}
{"event":"page_created","pageId":"page-1","contextId":"ctx-1","reason":"tab","openedVia":"newPage"}
{"event":"page_created","pageId":"page-2","contextId":"ctx-1","reason":"tab","openedVia":"window.open"}
```

Both pages share `ctx-1`; the second is `window.open`, whose opener is the
existing page (`window.opener !== null`), which Firefox only does for a tab or
popup inside that window. The page screenshot reported real dimensions
`1728x999`.

## Item status

1. Tabs not windows: `lib/tab-pages.js` plus launch prefs. Unit test
   `tests/unit/tabPages.test.js`; headful trace above.
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
   in 0.5 s.
8. `GET /tabs` without `userId` now lists every user's tabs and includes
   `userId`; with a `userId` it stays scoped. E2E test.
9. LinkedIn interstitial: navigate does a single `goto` (`waitUntil: commit`)
   followed by a domcontentloaded wait; it does not reload, run a login-wall
   check, or auto-click. Google/Amazon are the only special navigation paths.
   So the fork should not interrupt the self-redirect, but navigate can return
   at the first domcontentloaded before the interstitial finishes, so an
   immediate snapshot may still show the interstitial. No LinkedIn-specific
   server code was added.
