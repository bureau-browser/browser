# Native video recording (`agstudio/native-video`)

This branch adds per-tab native video recording backed by Playwright's
built-in `recordVideo` context option. It's opt-in — normal tabs and the
upstream session-pool behavior are untouched.

## Why

Upstream camofox-browser wraps one Playwright context per user session;
multiple tabs share the context. Playwright's `recordVideo` is a
per-context option, so enabling it would record every tab for every user
— wasteful and a privacy problem.

This branch solves that by giving each recorded tab its own dedicated
context. The tabs live in a top-level `recordedTabs` map alongside the
shared-session pool, and `findTab()` falls through to check it, so every
existing route (`/navigate`, `/snapshot`, `/click`, `/type`, `/evaluate`
…) keeps working unchanged.

## API

### `POST /tabs` — with `recordVideo`

```json
{
  "userId": "user-123",
  "sessionKey": "session-abc",
  "url": "https://example.com",
  "recordVideo": {
    "width": 1280,
    "height": 720
  }
}
```

Field | Type | Required | Default
---|---|---|---
`recordVideo` | object \| omitted | no | none (shared-session path, no video)
`recordVideo.width` | number | no | 1280
`recordVideo.height` | number | no | 720

When `recordVideo` is set, the tab is created in a **fresh, dedicated
Playwright context** with `recordVideo: { dir, size }` configured. The
context is NOT added to the user's shared session — it lives in a
top-level `recordedTabs` map, and no other tabs from that user see it.

Response mirrors the non-recorded path plus an echo:

```json
{
  "tabId": "t-abc123",
  "url": "https://example.com/",
  "recordVideo": { "width": 1280, "height": 720 }
}
```

### `GET /tabs/:tabId/video?userId=...` — fetch the WebM

```
GET /tabs/t-abc123/video?userId=user-123
→ 200 Content-Type: video/webm
→ <binary webm bytes>
```

On first invocation this endpoint closes the Playwright context — that's
what finalizes the `.webm` on disk — and then streams it back.
Subsequent calls return the cached file path without closing again.

Status codes:

- **200** — `.webm` streamed successfully
- **400** — `userId` query param missing
- **404** — tab not found (wrong id, wrong user, or outside grace
  window)
- **409** — context closed but Playwright produced no `.webm` file (rare;
  usually means the tab was closed before any page load)
- **410** — video file has been evicted (past `VIDEO_GRACE_WINDOW_MS`)

### `DELETE /tabs/:tabId` — close the recorded tab

Same URL as the upstream close endpoint. When the targeted tab is a
recorded tab:

1. The dedicated Playwright context is closed (if still open), which
   finalizes the `.webm` file.
2. The video directory stays on disk for `VIDEO_GRACE_WINDOW_MS`
   (default: 5 minutes) so a trailing `GET /tabs/:tabId/video` still
   works.
3. After the grace window, the dir is removed and the `recordedTabs`
   entry is evicted.

### Recommended order from the client

```
POST /tabs { recordVideo: {...} }        → { tabId }
(perform N navigate/click/type steps)
GET /tabs/:tabId/video                    → streams .webm (closes context)
DELETE /tabs/:tabId                       → bookkeeping cleanup
```

The `GET → DELETE` order is what the reference downstream client
(`@agstudio/integration-browser`) uses. The reverse `DELETE → GET` order
also works as long as the `GET` arrives within the grace window, but the
forward order is simpler and deterministic.

## Config

Env | Default | Meaning
---|---|---
`CAMOFOX_VIDEO_DIR` | `/tmp/camofox-videos` | Parent directory for per-tab video subdirs

Grace window (`VIDEO_GRACE_WINDOW_MS`) is hardcoded at 5 minutes in
`server.js`; open a PR if you want it configurable.

## Implementation notes

- **Isolation.** Recorded tabs live in a separate top-level
  `recordedTabs: Map<tabId, RecordedTabEntry>` map. They do **not**
  appear in `session.tabGroups` and are **not** counted in
  per-session tab limits. They ARE counted in `MAX_TABS_GLOBAL` via the
  `getTotalTabCount()` guard in `POST /tabs`.
- **Lookup.** `findTab(session, tabId)` checks `recordedTabs` first,
  falling back to `session.tabGroups`. All call sites (`/navigate`,
  `/click`, `/type`, `/snapshot`, `/evaluate`, etc.) resolve recorded
  tabs transparently.
- **Cookies.** Recorded tabs don't inherit cookies from the shared
  session context. If you need authenticated browsing in a recording,
  pass cookies at POST time via a separate cookie-import call on the
  dedicated context (TODO: add `recordVideo.cookies` field).
- **Proxy.** Recorded tabs use the same launch-time proxy as the shared
  browser. Per-session rotation from `proxyPool.canRotateSessions` is
  skipped for this first version.
- **Fly / tab recycling.** Recycling loops only operate on
  `session.tabGroups`, so recorded tabs never get recycled. They rely
  on their own grace-window cleanup.

## Downstream client

The reference downstream lives at `@agstudio/integration-browser`:

- `CamofoxBrowserProvider.createSession({ recordVideo: {...} })` — sends
  `recordVideo` on `POST /tabs`
- `CamofoxBrowserProvider.getRecordedVideo(tabId)` — calls
  `GET /tabs/:tabId/video` and returns the `Buffer`
- Gated by the `CAMOFOX_NATIVE_VIDEO=true` env flag so an unpatched
  upstream image doesn't silently accept `recordVideo` and produce no
  video

See `packages/integration/browser/src/automation/providers/camofox.adapter.ts`.
