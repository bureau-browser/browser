# Sync to upstream camofox-browser v1.18.1

Branch: `sync/upstream-v1.18.1`, created from upstream tag `v1.18.1`
(`39c8209`, 2026-10-05). Base of the fork work was v1.5.2 plus 17 commits.
Target branch for the PR: `agstudio/native-video`.

Everything below was run in this worktree on macOS, with a temp
`CAMOFOX_PROFILE_DIR`, a temp `CAMOUFOX_INSTALL_DIR`, and no proxy.

## Per-commit decisions (oldest first)

| # | Our commit | Decision | Where it landed / why |
|---|------------|----------|-----------------------|
| 1 | `cb9daf8` native per-tab video via Playwright recordVideo | obsolete | Playwright Firefox/Juggler recording produced 24 frames / 3 KB regardless of session length. Superseded by the ffmpeg recorder (commit 3) and then the frame-grab recorder (commit 11). No upstream equivalent. |
| 2 | `6fe6335` install Playwright ffmpeg | obsolete | The Playwright recordVideo path is gone; recording now uses system `ffmpeg`. Docker installs `ffmpeg` instead. |
| 3 | `0ee93b8` record via ffmpeg x11grab | replay (evolved) | `lib/video-recorder.js:84` keeps x11grab behind `CAMOFOX_X11GRAB=1`; Camoufox's own Xvfb is 1x1, so frame-grab is the default backend. |
| 4 | `f818b8b` ffmpeg spawn signature | obsolete (folded) | The recorder calls `spawn(command, args, options)` correctly in `lib/video-recorder.js`. |
| 5 | `4dc9c27` per-tab viewport via dedicated context | replay | `createDedicatedTab` (`server.js:3091`) and the `POST /tabs {viewport}` branch (`server.js:3348`). All `/tabs/:id/*` routes resolve dedicated tabs through `findTab`. |
| 6 | `3e5a582` Docker non-root uid 1001 | replay | Commit `d1e1f76`: Camoufox cache under `/home/camofox`, `USER camofox`, plus ffmpeg. |
| 7 | `c113eff` CAMOFOX_HEADFUL + CAMOFOX_PROFILE_DIR | partly covered upstream, partly replay | Persistent profiles are upstream (`lib/persistence.js`, `plugins/persistence/`, `lib/config.js:141`). Replayed the `CAMOFOX_HEADFUL=true` alias to the desktop interactive mode and legacy flat `<userId>.json` profile reads (`lib/persistence.js:31`). |
| 8 | `0bb050b` gcloudignore | replay | `.gcloudignore` added verbatim. The package-lock churn in that commit was incidental and is not replayed. |
| 9 | `239dbd2` human-input primitives + FR locale | replay, minus the FR default | `/type {human, delay}` (`server.js:4827`), `/mouse` (`server.js:5181`), `/slide` (`server.js:5248`). The FR default is deliberately not replayed: upstream has `CAMOFOX_LOCALE` + `CAMOFOX_TIMEZONE` (`lib/browser-identity.js`) and requires both. Set both to `fr-FR` / `Europe/Paris` to keep the old fingerprint. |
| 10 | `90677d0` persist httpOnly cookies | replay | `lib/persistence.js:210` merges `context.cookies()` (httpOnly + partitioned) over `storageState()` and the prior jar; `restoreCookiesIntoContext` re-injects the jar after context creation. |
| 11 | `77c89cc` frame-grab recorder, full viewport, durable jar | replay | Frame-grab recorder (`lib/video-recorder.js:39`); session contexts already use `viewport: null` upstream; jar durability is part of the persistence merge. |
| 12 | `a01e84b` auth-gated checkpoint persistence | replay | `AUTH_COOKIE_REGISTRY`, auth-downgrade refusal and `POST /sessions/:id/persist` (`server.js:2895`) in `lib/persistence.js:168`. |
| 13 | `b8c05b4` authed full-viewport recordVideo | replay | Dedicated recording tabs restore the persisted jar and re-inject cookies (`server.js:3091`). |
| 14 | `11e66f1` server-side network capture | replay | `POST/GET /tabs/:id/capture` (`server.js:2791`, `server.js:2827`). |
| 15 | `3ced84f` no probe window, idle timer | covered upstream | Idle shutdown is already idempotent (`server.js:720` guards on `browserIdleTimer`) and `BROWSER_IDLE_TIMEOUT_MS=0` is handled (`lib/config.js:119`). The Google probe only runs when a rotating proxy pool exists (`server.js:1216`), so a no-proxy headful host never opens it. |
| 16 | `807aafe` cap cookie jar / localStorage | replay | Jar cap (120 total, auth cookies always kept), localStorage caps and keepAlive in `lib/persistence.js`. `POST /tabs {keepAlive}` sets `session.keepAlive` (`server.js:3414`) and the reaper skips it (`server.js:6912`). |
| 17 | `add94bf` rebrand to Bureau Browser | replay | Commit `6e0e764`. Copyright notice kept, Agentik modification line added, package name `@bureau-browser/browser`, version stays 1.18.1. |

Additional commit:

| Change | Commit | Notes |
|--------|--------|-------|
| 2026-09-30 uncommitted `lib/config.js` fix + test | `d7258e1` | Upstream had already fixed `SESSION_TIMEOUT_MS=0` and `BROWSER_IDLE_TIMEOUT_MS=0` (`cb68c6e`). `TAB_INACTIVITY_MS` still used `parseInt(...) || 300000`; explicit `0` was silently replaced. Now parsed with `Number.isNaN`, and the reaper honors `TAB_INACTIVITY_MS <= 0`. Tests ported from the live checkout's uncommitted `tests/unit/sessionCleanup.test.js`. |

## Tests

All on the final tree (`6e0e764` + report commit).

```
npm run test:unit
  Test Suites: 77 passed, 77 total
  Tests:       2 skipped, 897 passed, 899 total

npm run test:plugins
  Test Suites: 7 passed, 7 total
  Tests:       48 passed, 48 total

CAMOFOX_PROFILE_DIR=<tmp> CAMOUFOX_INSTALL_DIR=<tmp cache> npm run test:e2e
  Test Suites: 16 passed, 16 total
  Tests:       82 passed, 82 total
```

E2E uses only the local Express test site (no external network, no credentials).
`tests/e2e/globalSetup.js` now forwards `CAMOFOX_PROFILE_DIR` and
`CAMOUFOX_INSTALL_DIR` so a run cannot clobber a real profile or browser cache.

## Bureau endpoint compatibility

Callers: `packages/drivers/src/camofox/client.ts` (driver),
`apps/bureau/src/lib/download-tools.ts`, `apps/bureau/src/lib/session-persist.ts`,
and `@agentproto/browser-profiles` `openSession`
(`apps/bureau/src/lib/human-session.ts` consumes it).

| Bureau call | Caller | v1.18.1 + this branch | Shape verdict |
|-------------|--------|-----------------------|---------------|
| `POST /tabs` | `client.ts:180`, browser-profiles `index.mjs:907` | `server.js:3348` | Same `{tabId, url, httpStatus, navigationOk}`. Accepts `storageState`, `keepAlive`, `recordVideo`, `viewport` (the last two are this branch). |
| `POST /tabs/:id/navigate` | `client.ts:189`, `index.mjs:915/930` | `server.js:3611` | Same `{ok, tabId, url, httpStatus, navigationOk}`. `waitUntil`/`timeout` are accepted but ignored; the route uses its own domcontentloaded policy (`server.js:3615`), which matches Bureau's 2.5 s settle. |
| `POST /tabs/:id/click` | `client.ts:198`, `index.mjs:976` | `server.js:4320` | Same `{ok}`; CSS selector is required and trusted mouse events are dispatched. |
| `POST /tabs/:id/type` | `client.ts:202`, `index.mjs:979` | `server.js:4827` | Same `{ok}`. `human: true` + `delay` are now honored (upstream ignored them); this is the fork's human-typing path. |
| `GET /tabs/:id/screenshot` | `client.ts:215`, `index.mjs:938` | `server.js:6002` | Same raw image bytes. `format`, `quality`, `selector` and `fullPage` are now honored; plain v1.18.1 always returned PNG of the whole page. |
| `POST /tabs/:id/evaluate` | `client.ts:227`, `index.mjs:926` | `server.js:6167` | Same `{ok, result}`. |
| `GET /tabs/:id/video` | `client.ts:234` | `server.js:6427` | Same `video/webm` stream; added by this branch. 400 for a non-recording tab, 404 unknown, 410 expired file. |
| `POST /sessions/:id/cookies` | `client.ts:238`, `index.mjs:885` | `server.js:416` | Same `{ok, userId, count}`. `sessionKey` is accepted but ignored (cookies are context-scoped). `partitionKey` is not in the accepted field list, so CHIPS cookies supplied by a caller are dropped; the persisted jar path keeps them. |
| `DELETE /tabs/:id` | `client.ts:245`, `index.mjs:999` | `server.js:6471` | Same `{ok}`. Dedicated recording/viewport contexts are finalized first. |
| `GET /tabs?userId` | `client.ts:251`, `download-tools.ts:87`, `index.mjs:894` | `server.js:7106` | Same `{running, tabs:[{tabId,targetId,url,title,listItemId}]}`; dedicated tabs are included. |
| `GET /tabs/:id/downloads` | `download-tools.ts:109` | `server.js:5841` | Same `{tabId, downloads}`; `includeData`, `maxBytes`, `consume` supported. |
| `POST /sessions/:id/persist` | `session-persist.ts:122/154` | `server.js:2895` | Same intent; returns `{ok, written, authed, cookies, reason?}` (names only, never values). Added by this branch. |
| `POST /tabs/:id/capture` | browser-profiles `index.mjs:985` | `server.js:2791` | Same `{ok, armed, urlPattern}`. |
| `GET /tabs/:id/capture` | browser-profiles `index.mjs:993` | `server.js:2827` | Same `{requests:[...]}`. |
| `POST /tabs/:id/press` | `index.mjs:982` | `server.js` press route | Same `{ok}`. |
| `GET /health` | Bureau health probe | `server.js:2929` | Same `{ok, engine, browserConnected, browserRunning, ...}`; memory fields are additive. |

Notes for the next Bureau change:

- `GET /tabs/:id/screenshot` used to ignore `selector`/`format`/`quality`. Bureau's
  detector already tolerated PNG, but it now gets the JPEG/quality/crop it asks for.
- `POST /tabs/:id/navigate` ignores `waitUntil`; if Bureau ever needs a hard
  network-idle wait it must call `/wait` or settle client-side.
- `POST /sessions/:id/cookies` cannot carry `partitionKey`. A partitioned login
  cookie imported through that route will not stick; the persisted jar route does.

## Live smoke

Server: synced code, headless, `PORT=9380`, temp profile dir.
Bureau: `bureau-wt-dogfood` `apps/bureau/dist/index.js serve --port 8840`, temp
`BUREAU_HOME`, `CAMOFOX_URL=http://127.0.0.1:9380`. Device token minted locally
with `bureau install-mcp --config <temp>/mcp.json`; never printed.

REST sequence against :9380:

| Action | Result |
|--------|--------|
| `POST /tabs` example.com | 200, `httpStatus: 200`, tabId returned |
| `GET /tabs/:id/snapshot` | 200, accessibility text |
| `GET /tabs/:id/screenshot?...&format=jpeg&quality=60&selector=body` | 200, `image/jpeg`, 40 KB |
| `POST /tabs/:id/capture` then navigate wikipedia then `GET` | 200, 7 requests |
| `POST /tabs/:id/mouse` | 200 |
| `POST /tabs/:id/type {human:true, delay:30}` | 200, value `OpenCode` read back |
| `POST /sessions/main/persist` | 200, `written: true` |
| `POST /tabs {viewport:{375x667}}` + evaluate | 200, `innerWidth/innerHeight = 375/667` |
| `POST /tabs {recordVideo:{640x360,fps:4}}`, 4 s, `GET /video` | 200, `video/webm`, 17 KB |
| second tab same user, second user, concurrent evaluate | titles returned from both contexts |

Bureau MCP sequence on :8840 (10 calls, all `isError: false`):

| Tool | ms | Result |
|------|----|--------|
| `browser_navigate` example.com | 1864 | ok |
| `browser_get_dom` | 6 | HTML |
| `browser_evaluate` title/links | 3 | `Example Domain` |
| `browser_screenshot` (path) | 23 | PNG 92 KB |
| `browser_click` `a` | 3253 | ok |
| `browser_navigate` wikipedia.org | 1471 | ok |
| `browser_evaluate` input count | 5 | 13 inputs |
| `browser_fill` search box | 3885 | `OpenCode` read back (human paced) |
| `bureau_tabs` | 27 | control tab listed |

The MCP surface in this Bureau build exposes one anonymous control tab, so
"second tab in the same session" and "second caller session" were exercised
directly against the camofox REST API (both succeeded). Recording and
per-viewport tabs likewise have no MCP tool here; both were exercised directly
on the endpoints the Bureau client/caller uses.

## Upstream additions since v1.5.2 worth adopting in Bureau

- Downloads with inline bytes and `consume` (`GET /tabs/:id/downloads`,
  `server.js:5841`). Bureau already uses it in `download-tools.ts`.
- `/tabs/:id/wait` (`server.js:4237`) for explicit readiness instead of a fixed
  client-side settle.
- `/tabs/:id/select` (`server.js:4989`) for native selects, `/upload`
  (`server.js:4620`), `/extract` (`server.js:6309`) with a JSON schema, `/stats`
  (`server.js:6079`), `/tabs/:id/fetch-current-resource` (`server.js:5747`).
- Playwright traces for a session (`server.js:6627`, `lib/tracing.js`), useful
  for debugging a failed recipe without reproducing it.
- Session persistence plugin (`plugins/persistence/`, `lib/persistence.js`) and
  the legacy profile layout migration implemented here.
- Popup tracking (`attachPopupHandler`, `server.js:1858`) so `target=_blank`
  Tabs are managed instead of orphaned.
- Page leases and new-page recovery (`lib/page-lease.js`,
  `lib/new-page-recovery.js`), and per-tab locks (already present at v1.5.2 but
  substantially hardened).
- Interactive/VNC mode (`plugins/vnc/`, `CAMOFOX_INTERACTIVE`) and the health
  contract with browser state/memory (`server.js:2929`).
- Crash reporter/Sentry (`lib/reporter.js`, `lib/sentry.js`), proxy pool
  (`lib/proxy.js`), Windows process ownership (`lib/windows-processes.js`), and
  the generated OpenAPI docs (`lib/openapi.js`).
- `CAMOFOX_LOCALE` + `CAMOFOX_TIMEZONE` as the supported identity knobs; use
  both (`fr-FR` + `Europe/Paris`) where the fork used to hardcode FR.

## Deployment notes

- The installed Camoufox binary must match `camoufox-js` 0.11.5 (the package
  baked into this branch expects 152.0.4). The host cache used during this sync
  still held 135.0.1; basic tabs worked, but `Browser.setDefaultViewport` failed
  with "Found property `<root>.viewport.isMobile` - false which is not described
  in this scheme". After provisioning the matching binary into a temp
  `CAMOUFOX_INSTALL_DIR`, viewport and recording passed. The Dockerfile bakes
  the pinned version.
- Existing profiles in `/Users/jeremy/.agentproto/camofox-profiles` are flat
  `<userId>.json`. `loadPersistedStorageState` reads that layout and then writes
  the new hashed layout on the next checkpoint, so a deploy keeps logins.
- `CAMOFOX_HEADFUL=true` is still the supported way to get the visible-window
  service; it now maps onto the upstream desktop interactive mode.
