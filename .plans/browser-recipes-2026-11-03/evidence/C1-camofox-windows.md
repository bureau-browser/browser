# C1 - dogfood the camofox headful window experience

Date: 2026-11-04. Worktree: `/Volumes/SSDExternalMacStudio/Code/_agentproto-worktrees/camofox/c1-dogfood`,
branch `dogfood/windows`. Server: this worktree at `add94bf` plus the trace commit. Bureau:
`bureau-wt-dogfood` (apps/bureau/dist) on :8839, temp `BUREAU_HOME`, `CAMOFOX_URL=http://127.0.0.1:9379`.
Camofox: headful, :9379, temp profile dir, `CAMOFOX_TRACE_WINDOWS=1`. Public pages only; no login,
no form submit.

## What a "window" is here

In headful Firefox a Playwright page is a top-level window, not a tab. Juggler's
`TargetRegistry.newPage` calls `Services.ww.openWindow(...)` and then asserts the new window
has exactly one tab (see the answer section below). A Playwright `BrowserContext` is only a
Firefox container (`userContextId`), so a context by itself opens no window; every
`context.newPage()` opens one window. The table therefore counts windows as
`page_created` events, and lists contexts separately where they matter.

Trace format (this branch, `lib/window-trace.js`, enabled by `CAMOFOX_TRACE_WINDOWS=1`): one
JSON line per context and page create/close, emitted as `"msg":"window-trace"`, with a `reason`
on every line (`session-create`, `tab`, `dedicated-tab`, `dedicated-tab-close`, `reaper`,
`idle-shutdown`, `probe`, `restart`, ...). `camofox-js` stays scanner-safe: the only env read
is `traceWindows` in `lib/config.js`; the tracer has no env or network tokens.

## Action -> windows

Run 2 trace starts at 23:18:05Z. "Expected" is what the API semantics imply (a tab should be
a tab, a probe should be invisible).

| # | Action (caller) | Windows opened | Windows closed | Expected | Trace evidence |
|---|---|---|---|---|---|
| 1 | Cold `browser_navigate` to example.com (MCP -> control tab) | 1 | 0 | 1 | `context_created session-create ctx-1`, `page_created page-1 tab ctx-1 autoCreated:true` |
| 2 | Second `browser_navigate` (wikipedia) on the same control session | 0 | 0 | 0 | no `page_created`; the control driver reuses its cached tab (`packages/mcp/src/index.ts:126-142`) |
| 3 | `browser_get_dom` (snapshot equivalent) | 0 | 0 | 0 | no trace line; 35 ms |
| 4 | `browser_click` by selector (run 1, wikipedia) | 0 | 0 | 0 | no trace line; call failed after 30 448 ms, see papercuts |
| 5 | `browser_fill` (run 1, wikipedia) | 0 | 0 | 0 | no trace line; call failed after 30 366 ms, see papercuts |
| 6 | `browser_screenshot` to file | 0 | 0 | 0 | no trace line; 78 ms, but width/height came back 0 |
| 7 | Second tab in the same session: `POST /tabs {userId:"main",sessionKey:"main"}` (Camofox REST; no MCP tool exists for this) | 1 | 0 | 0 (a tab) | `page_created page-2 tab ctx-1` |
| 8 | Two caller sessions at the same time (subsession tokens caller-a/caller-b, concurrent `browser_navigate`) | 0 | 0 | 0 | no `page_created`; both ran on the one control tab in 1.9 s / 1.6 s, so the second call overwrote the first page |
| 9 | `recordVideo` dedicated tab: `POST /tabs {recordVideo:...}` then `GET /tabs/:id/video` | 1 (+1 context) | 1 at `GET /video` | 1 | `context_created dedicated-tab ctx-2`, `page_created page-3`, `page_closed ...-close-context`, `context_closed dedicated-tab-close closeReason:"get"` |
| 10 | Per-viewport tab: `POST /tabs {viewport:{800,600}}` then `DELETE /tabs/:id` | 1 (+1 context) | 0 at DELETE | 1 at DELETE | `context_created dedicated-tab ctx-3`, `page_created page-4`, then nothing on DELETE; see papercut 4 |
| 11 | `DELETE /tabs/:id` for the two control tabs, then `DELETE /sessions/main` | 0 | 2 + context | 2 | `page_closed page-1 tab-close`, `page_closed page-2 tab-close`, `context_closed session-close` |
| 12 | Idle 6 min after the last session | 0 | 1 leaked + browser | 0 | `23:23:44.938 browser idle shutdown`; `page_closed page-4 idle-shutdown-context`, `context_closed ctx-3 idle-shutdown` (5 min after the last session, as configured) |
| 13 | Call again after the idle wait (`browser_navigate`) | 1 + new browser | 0 | 1 | `launching camoufox` 23:24:13.506, `context_created ctx-5 session-create`, `page_created page-5` |

Total across run 2: 6 windows opened (`page-1..page-5`, plus one relaunch page), 4 user-visible
windows closed by explicit calls, one leaked and closed only by idle shutdown, one closed by
`GET /video`. Every `browser_click`/`fill` attempt produced zero extra windows; the bad part is
the timeouts, not windows.

Probe contexts: `23:20:50.785 context_created probe ctx-4` / `... context_closed probe-done ctx-4`
after 120 s idle. In headful the probe skips `newPage` (`server.js`, health probe), so a probe
context opened zero windows. That is correct today, but it is still a context every 2 minutes.

Verbatim trace (run 2):

```json
{"ts":"2026-11-03T23:18:05.272Z","level":"info","msg":"window-trace","event":"context_created","contextId":"ctx-1","reason":"session-create","pid":16395,"userId":"main"}
{"ts":"2026-11-03T23:18:05.692Z","level":"info","msg":"window-trace","event":"page_created","pageId":"page-1","contextId":"ctx-1","reason":"tab","userId":"main","tabId":"01c77dc9-0a33-49b5-a4f6-a031d8ae521c","autoCreated":true}
{"ts":"2026-11-03T23:18:18.192Z","level":"info","msg":"window-trace","event":"page_created","pageId":"page-2","contextId":"ctx-1","reason":"tab","userId":"main","sessionKey":"main"}
{"ts":"2026-11-03T23:18:27.718Z","level":"info","msg":"window-trace","event":"context_created","contextId":"ctx-2","reason":"dedicated-tab","pid":16395,"userId":"main","tabId":"c4f98be6-e41b-42b3-a132-4a23abd4aa9f","recorded":true,"width":1280,"height":720}
{"ts":"2026-11-03T23:18:27.883Z","level":"info","msg":"window-trace","event":"page_created","pageId":"page-3","contextId":"ctx-2","reason":"dedicated-tab","tabId":"c4f98be6-e41b-42b3-a132-4a23abd4aa9f","recorded":true}
{"ts":"2026-11-03T23:18:31.872Z","level":"info","msg":"window-trace","event":"page_closed","pageId":"page-3","contextId":"ctx-2","reason":"dedicated-tab-close-context"}
{"ts":"2026-11-03T23:18:31.872Z","level":"info","msg":"window-trace","event":"context_closed","contextId":"ctx-2","reason":"dedicated-tab-close","createdReason":"dedicated-tab","userId":"main","tabId":"c4f98be6-e41b-42b3-a132-4a23abd4aa9f","closeReason":"get"}
{"ts":"2026-11-03T23:18:31.902Z","level":"info","msg":"window-trace","event":"context_created","contextId":"ctx-3","reason":"dedicated-tab","pid":16395,"userId":"main","tabId":"b3418e4e-18b6-4cf4-b0d0-5ad988bc308a","recorded":false,"width":800,"height":600}
{"ts":"2026-11-03T23:18:32.058Z","level":"info","msg":"window-trace","event":"page_created","pageId":"page-4","contextId":"ctx-3","reason":"dedicated-tab","tabId":"b3418e4e-18b6-4cf4-b0d0-5ad988bc308a","recorded":false}
{"ts":"2026-11-03T23:18:44.841Z","level":"info","msg":"window-trace","event":"page_closed","pageId":"page-1","contextId":"ctx-1","reason":"tab-close","tabId":"01c77dc9-0a33-49b5-a4f6-a031d8ae521c"}
{"ts":"2026-11-03T23:18:44.861Z","level":"info","msg":"window-trace","event":"page_closed","pageId":"page-2","contextId":"ctx-1","reason":"tab-close","tabId":"a552b3a1-94ff-4ab1-ae61-a87dfd942c42"}
{"ts":"2026-11-03T23:18:44.929Z","level":"info","msg":"window-trace","event":"context_closed","contextId":"ctx-1","reason":"session-close","createdReason":"session-create","userId":"main"}
{"ts":"2026-11-03T23:20:50.785Z","level":"info","msg":"window-trace","event":"context_created","contextId":"ctx-4","reason":"probe","pid":16395,"probe":"health"}
{"ts":"2026-11-03T23:20:50.786Z","level":"info","msg":"window-trace","event":"context_closed","contextId":"ctx-4","reason":"probe-done","createdReason":"probe","probe":"health"}
{"ts":"2026-11-03T23:23:44.938Z","level":"info","msg":"window-trace","event":"page_closed","pageId":"page-4","contextId":"ctx-3","reason":"idle-shutdown-context"}
{"ts":"2026-11-03T23:23:44.938Z","level":"info","msg":"window-trace","event":"context_closed","contextId":"ctx-3","reason":"idle-shutdown","createdReason":"dedicated-tab","userId":"main","tabId":"b3418e4e-18b6-4cf4-b0d0-5ad988bc308a"}
{"ts":"2026-11-03T23:24:15.678Z","level":"info","msg":"window-trace","event":"context_created","contextId":"ctx-5","reason":"session-create","pid":16395,"userId":"main"}
{"ts":"2026-11-03T23:24:15.886Z","level":"info","msg":"window-trace","event":"page_created","pageId":"page-5","contextId":"ctx-5","reason":"tab","userId":"main","tabId":"01c77dc9-0a33-49b5-a4f6-a031d8ae521c","autoCreated":true}
{"ts":"2026-11-03T23:24:24.068Z","level":"info","msg":"window-trace","event":"page_closed","pageId":"page-5","contextId":"ctx-5","reason":"session-close-context"}
{"ts":"2026-11-03T23:24:24.068Z","level":"info","msg":"window-trace","event":"context_closed","contextId":"ctx-5","reason":"session-close","createdReason":"session-create","userId":"main"}
```

## Papercuts

1. `browser_click` by CSS selector times out on Wikipedia. Run 1: 30 448 ms then
   `{"error":"action timed out after 30000ms"}`. The server log shows the normal
   `locator.click({timeout:3000})` failing and the mouse-sequence fallback then hanging:
   `23:12:46.282 click timeout, trying mouse sequence` then `23:13:13.281 click failed`.
   Same for the second click attempt. `browser_fill` fails the same way (30 366 ms,
   `type failed ... action timed out after 30000ms`). `document.querySelector` showed the
   selector was valid on a neighbouring page, so this is the action path, not the selector.
2. `browser_fill` takes `value`, not `text`; the first call returned a zod
   `expected string, received undefined` at path `value` in 16 ms. The camofox AGENTS.md
   documents `/type` with `text`, so the MCP wrapper and the REST API disagree.
3. `browser_screenshot` returns `"width":0,"height":0` with `viewport:null` (session
   contexts). The image is 507 KB and valid; only the reported dimensions are wrong.
4. Per-viewport dedicated tab leaks its context and window on `DELETE`. The tab is created
   with `recordVideo` absent, so `finalizeRecording` sets `videoSettled:true` at creation and
   `finalizeRecording` returns immediately on close; its `recorded.context.close()` never
   runs (`server.js`, `finalizeRecording` early return). Trace shows `ctx-3` / `page-4`
   created at 23:18:31/32 and no close line on DELETE at 23:18:33. The window stayed open
   until the 5 min browser idle shutdown at 23:23:44. Run 1 reproduced the same leak.
5. `GET /tabs` does not list `dedicatedTabs` (`server.js`, `/tabs` only walks
   `session.tabGroups`). `bureau_tabs` therefore showed only the two control tabs while the
   leaked viewport window was still on screen, and `/health` reported `activeTabs:0` with
   that window open. Bureau cannot see or close dedicated tabs through any MCP tool.
6. The 25 MCP tools have no tab-create and no tab-close tool. Close is REST-only
   (`DELETE /tabs/:id`), and create-with-viewport/recordVideo is REST-only. Bureau's
   recording (`apps/bureau/src/serve.ts:631-649`) is per-action frames, not a camofox
   `recordVideo` tab; it is off unless `BUREAU_RECORD_SESSIONS=1`.
7. Two caller sessions do not get separate tabs. With subsession tokens caller-a and
   caller-b, concurrent `browser_navigate` calls both drove the one cached control driver
   (`packages/mcp/src/index.ts:126-142`) and overwrote each other's page. Concurrency
   serializes on the tab lock; no isolation, no new window.
8. After a server restart, Bureau's cached control tab id is stale. The next navigate
   auto-created a new page and reused the old tab id (`autoCreated:true`), which works but
   hides the restart in tab listings.
9. Recording finalization at `GET /video` took 9.0 s in run 1 (3 navigations, frame-grab
   backend, ~1 MB webm) and 1.8 s in run 2 (2 s of recording, 240 KB). The `GET` is what
   closes the window, not the later `DELETE`; a caller that only deletes leaves the window
   until idle shutdown.
10. Timing on the normal path was fine: navigate 1.6-3.6 s, DOM 35-94 ms, screenshot 78 ms,
    `bureau_tabs` 49 ms. The 30 s action timeouts dominate the bad experience.

## Which Bureau calls create a new user/context or window

- `apps/bureau/src/serve.ts:146` pins the anonymous control scope to `CONTROL_USER_ID =
  "main"`, and `:213` builds one client with `createCamofoxClient(CONTROL_USER_ID)`.
- `apps/bureau/src/lib/browser-registry.ts:117-124` binds the client to a fixed `userId`
  (default `"main"` in `packages/drivers/src/camofox/client.ts:130`). All control tools share
  that one client.
- `packages/mcp/src/index.ts:126-142` caches one attached driver per browser kind, so every
  `browser_navigate` / `evaluate` / `click` / `fill` / `screenshot` / `get_dom` call uses the
  same camofox session and tab. The first call is the only one that creates a tab; it did
  create one window.
- `packages/drivers/src/camofox/client.ts:177-187` is the only tab creation: `POST /tabs`
  with `{userId, sessionKey}`. In this server it creates a page (`session.context.newPage()`
  in `server.js` POST `/tabs`) and starts a new window.
- `packages/drivers/src/camofox/index.ts:285-289` (`CamofoxDriverProvider.attach`) creates a
  session/tab per resolve. `apps/bureau/src/lib/active-driver-pool.ts:165-170` memoises one
  resolve per saved session id, so each distinct saved session is one camofox userId and one
  tab, hence one more window. The ad-hoc control scope never creates a second one.
- `apps/bureau/src/serve.ts:750` creates a screenshot-only client per `userId` for the live
  view; that path reads, it does not create tabs in this run.
- `apps/bureau/src/lib/download-tools.ts:87` reads `GET /tabs?userId=` and takes the single
  tab; it does not create windows, but it inherits the `GET /tabs` blind spot for dedicated
  tabs.

## Can Playwright Firefox (Juggler) open a page as a tab of an existing window?

No, not with the Juggler implementation shipped with Camoufox.

- Playwright side: `node_modules/playwright-core/lib/server/firefox/ffBrowser.js:219-227`
  `doCreateNewPage()` sends exactly `Browser.newPage { browserContextId }`. There is no
  window/tab target, no `opener`, no existing-page id.
- Juggler side (Camoufox `omni.ja`, `chrome/juggler/content/TargetRegistry.js:310-355`):
  `newPage({browserContextId})` resolves the context, builds the window arguments, then calls
  `Services.ww.openWindow(null, AppConstants.BROWSER_CHROME_URL, '_blank', features, args)`.
  It waits for the window, then asserts `window.gBrowser.browsers.length === 1` and returns
  that window's only browser target. `browserContextId` maps to Firefox `userContextId`
  (container isolation), not to a window or tab group.
- `BrowserHandler.js:132-134` just forwards `Browser.newPage` to that method. There is no
  `Browser.newTab` in the protocol (`chrome/juggler/content/protocol/Protocol.js:270` lists
  only `newPage`).

So every `context.newPage()` is a new top-level window. The current camofox code compounds
this by calling `newPage()` per tab, per dedicated context, and (in camera/recording tabs) per
dedicated context again.

What reduces windows without changing Juggler:

1. Use one page per context and navigate it in place. This is what the control tools already
   do (one cached tab); the extra windows come from additional `POST /tabs` calls and
   dedicated contexts, not from navigate.
2. Do not use a dedicated context for a "tab". A second tab in the same session must either
   reuse the existing page (navigate) or accept that Playwright will open a second window. A
   real tab needs a multi-tab abstraction that Juggler does not expose.
3. For recordings, capture the existing window (Bureau's per-action recorder already does
   this) instead of `recordVideo`, which unconditionally creates a dedicated context/page.
   If `recordVideo` stays, record on the session page or make the recorder reuse it.
4. For custom viewports, prefer one launch-time window size and navigate the same page;
   `viewport` is fixed at `newContext` time and the code deliberately creates a context per
   size. Accepting a single size per browser removes those windows.
5. Fix the viewport-only close leak (papercut 4) and make `GET /tabs` include
   `dedicatedTabs` so any leftover can be seen and closed instead of waiting for the 5 min
   idle shutdown.
6. Raise `BROWSER_IDLE_TIMEOUT_MS` / `TAB_INACTIVITY_MS` only as damage control; the idle
   shutdown is visible as a window close and the next call relaunches a whole browser (two
   window-level costs observed in row 12/13).
7. If true tabs are non-negotiable, the only route is a Juggler patch that, for a page in a
   context that already has a window, calls `window.gBrowser.addTab(...)` on that existing
   window instead of `Services.ww.openWindow`. That is a Camoufox/Juggler change, not a
   Playwright or camofox-server change, and it is not present in this build.

## Test run

`tests/unit` (13 suites, 167 tests) passes on the branch. No e2e/live suite was run; those
need a live browser and would open more headful windows.

## Cleanup

Only processes started for this lane were used: the camofox server on :9379 (pids recorded in
the temp dir), one Bureau on :8839 with a temp `BUREAU_HOME`, and their browser child. All were
stopped by recorded pid; the browser process exited with the server. The live :9377 launchd
service, Jeremy's Bureau :8830 and Chrome were untouched.
