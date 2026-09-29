# Bureau API contract

What Bureau, the kit supervisor and the camofox provider consume from this
server. Everything here is additive over upstream: no existing field was
removed or renamed.

## `GET /health`

Unauthenticated. Always JSON.

### 200 (healthy, or idle with nothing to warm)

```json
{
  "ok": true,
  "engine": "camoufox",
  "browserConnected": true,
  "browserRunning": true,
  "activeTabs": 2,
  "activeSessions": 1,
  "keepAliveSessions": 1,
  "consecutiveFailures": 0,
  "bootId": "6b0f4f3e-1c2a-4d1e-9a55-0f6a7d3c9b21",
  "startedAt": "2026-09-29T07:30:12.481Z",
  "browserState": "running",
  "launchedAt": "2026-09-29T07:30:19.902Z",
  "launchStartedAt": null,
  "lastLaunchMs": 7421,
  "lastRestartReason": null,
  "lastRestartAt": null,
  "launchBudgetMs": 120000,
  "consecutiveLaunchFailures": 0,
  "consecutiveContextFailures": 0,
  "crashLoopThreshold": 3
}
```

A freshly started server with no browser yet answers 200 with
`"browserState": "idle"`, `"browserConnected": false`, `"launchedAt": null`,
`"lastLaunchMs": null`. The browser launches lazily on the first tab, or on
`POST /start`. `idle` is not an error.

### Fields

| Field | Type | Meaning |
|-------|------|---------|
| `ok` | boolean | `false` only on the 503 shapes below |
| `engine` | string | Always `"camoufox"` |
| `browserConnected` / `browserRunning` | boolean | A browser is launched and connected right now |
| `activeTabs` / `activeSessions` | number | Live counts |
| `keepAliveSessions` | number | Sessions with `keepAlive: true` (200 shape only) |
| `consecutiveFailures` | number | Consecutive navigation failures (existing field, unchanged) |
| `bootId` | string (uuid) | Random per **server process**. Stable across browser restarts inside one process. A different value means the process restarted: all sessions and tabs are gone |
| `startedAt` | ISO string | Process start |
| `browserState` | enum | `launching` \| `running` \| `idle` \| `crash-looping`, see below |
| `launchedAt` | ISO string or `null` | When the most recent successful launch completed |
| `launchStartedAt` | ISO string or `null` | Start of the in-flight launch, `null` when none |
| `lastLaunchMs` | number or `null` | Duration of the most recent launch attempt, success or failure |
| `lastRestartReason` | string or `null` | Why the browser was last restarted by the server: `newcontext_timeout`, `browser_disconnected`, `health probe failed`. `null` until the first restart |
| `lastRestartAt` | ISO string or `null` | When that restart was recorded |
| `launchBudgetMs` | number | Effective `CAMOFOX_LAUNCH_TIMEOUT_MS` |
| `consecutiveLaunchFailures` | number | Reset by a successful launch or by `POST /start` |
| `consecutiveContextFailures` | number | Consecutive `newContext` timeouts. Reset by a successful `newContext` or by `POST /start` |
| `crashLoopThreshold` | number | Effective `CAMOFOX_CRASH_LOOP_THRESHOLD` |
| `machineId` | string | Only on Fly.io |

### `browserState`

| Value | When | Supervisor action |
|-------|------|-------------------|
| `idle` | No browser running, none launching. Normal after `BROWSER_IDLE_TIMEOUT_MS` with no sessions, and at boot | None. It launches on demand |
| `launching` | A launch is in flight, or the server is recovering | Wait. A slow launch is not a failure while it stays inside `launchBudgetMs`. Do not restart the server |
| `running` | Browser launched and connected | None |
| `crash-looping` | `crashLoopThreshold` consecutive failed launches (a launch over budget counts as one), or that many consecutive `newContext` timeouts | Automatic launches have stopped. Fix the cause (load, disk, binary), then `POST /start` |

`launching` takes precedence over `running`/`idle`; `crash-looping` takes
precedence over everything.

### 503 shapes

Recovering (server-side recovery in progress):

```json
{ "ok": false, "engine": "camoufox", "recovering": true, "bootId": "...", "browserState": "launching", "...": "lifecycle fields" }
```

Warming (proxy-pool deployments only, browser not up yet):

```json
{ "ok": false, "engine": "camoufox", "browserConnected": false, "browserRunning": false, "warming": true, "browserState": "idle", "...": "lifecycle fields" }
```

Crash-looping:

```json
{ "ok": false, "engine": "camoufox", "browserConnected": false, "browserRunning": false, "browserState": "crash-looping", "consecutiveLaunchFailures": 3, "crashLoopThreshold": 3, "...": "lifecycle fields" }
```

Every 503 carries the full lifecycle field set (`bootId`, `startedAt`,
`browserState`, ...) so a supervisor can tell "same process, browser unhappy"
from "new process".

### Reading it as a supervisor

- Process identity: compare `bootId` between polls. Changed means the server
  restarted, so re-create sessions and re-sync cookies.
- Liveness: an HTTP answer at all. Readiness for tabs: `ok: true`.
- Restart the server only on `crash-looping` that `POST /start` does not
  clear, never on `launching`.

## `POST /start`

Launches the browser if it is not running and **resets the crash-loop
counters**. This is the only way out of `crash-looping`.

```json
{ "ok": true, "profile": "camoufox" }
```

Failure: HTTP 500 `{ "ok": false, "error": "..." }`. A failed explicit start
counts as one launch failure.

## Tab and session fields

### `POST /tabs`

Request (relevant fields): `{ "userId": "...", "sessionKey": "...", "url": "...", "keepAlive": true }`

- `keepAlive: true` marks the session keep-alive, `false` clears it, absent leaves it as is.
- The flag is per session (per `userId`), not per tab.

Response:

```json
{ "tabId": "9c1d...", "url": "about:blank", "keepAlive": true }
```

When the browser is `crash-looping` this route answers:

```json
HTTP 503
{ "error": "Browser is crash-looping after 3 consecutive failures; launches are paused until an explicit POST /start", "code": "browser_crash_looping" }
```

### `GET /tabs?userId=...`

```json
{
  "running": true,
  "keepAlive": true,
  "tabs": [
    {
      "targetId": "9c1d...",
      "tabId": "9c1d...",
      "url": "https://example.com/",
      "title": "Example Domain",
      "listItemId": "main",
      "keepAlive": true
    }
  ]
}
```

Unknown user: `{ "running": true, "keepAlive": false, "tabs": [] }`.

### `GET /sessions`

Bearer-gated (`Authorization: Bearer $CAMOFOX_API_KEY`) when `CAMOFOX_API_KEY`
is set, open otherwise. Wrong or missing key: 403 `{ "error": "Forbidden" }`.

```json
{
  "sessions": [
    { "userId": "bureau-x", "keepAlive": true, "tabs": 1, "lastAccess": "2026-09-29T07:41:03.120Z" }
  ]
}
```

## keepAlive semantics

A session with `keepAlive: true`:

- is skipped by the idle tab reaper (`TAB_INACTIVITY_MS`), including when its last tab is gone;
- is skipped by the session-expiry sweep (`SESSION_TIMEOUT_MS`);
- keeps the browser open: the idle browser timer (`BROWSER_IDLE_TIMEOUT_MS`) never closes the browser while any session exists;
- keeps the flag when the session's context is recreated (dead context, or a cookie jar that gained auth).

It does not:

- survive a browser restart (`POST /stop`, `newcontext_timeout`, `browser_disconnected`). All contexts die with the browser. Check `bootId` and `lastRestartAt`, then re-create the session;
- apply to tabs created through the dedicated-context path (`recordVideo` or `viewport`), which live outside the shared session;
- survive a server process restart (`bootId` changes).

## Environment

| Variable | Default | Effect |
|----------|---------|--------|
| `CAMOFOX_LAUNCH_TIMEOUT_MS` | `120000` | Budget for one launch. Inside the budget a slow launch is not a failure. Over it: attempt cancelled, its children reaped, one failure counted |
| `CAMOFOX_NEWCONTEXT_TIMEOUT_MS` | `60000` | Budget for `newContext`. Timeout restarts the browser (`lastRestartReason: newcontext_timeout`) and retries once |
| `CAMOFOX_CRASH_LOOP_THRESHOLD` | `3` | Failures in a row before `crash-looping` |
| `BROWSER_IDLE_TIMEOUT_MS` | `300000` | Idle browser shutdown (0 = never). Blocked by any session |
| `TAB_INACTIVITY_MS` | `300000` | Idle tab reaper. Skips keep-alive sessions |
| `SESSION_TIMEOUT_MS` | `600000` | Session expiry sweep. Skips keep-alive sessions |

## Orphan reaping

The server records the camoufox child pids of each launch. On a failed or
over-budget launch, and after every browser close, it terminates only pids
that are still direct children of the server process and still look like
camoufox (SIGTERM, a 2s grace, then SIGKILL, on the process group when the
child leads one). There is no global `pkill`, so a camoufox started by
something else on the same machine is never touched.
