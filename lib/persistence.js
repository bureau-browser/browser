import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function safeUserSlug(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getUserPersistencePaths(profileDir, userId) {
  const rootDir = path.resolve(profileDir);
  const safeUserDir = crypto
    .createHash('sha256')
    .update(String(userId))
    .digest('hex')
    .slice(0, 32);

  const userDir = path.join(rootDir, safeUserDir);
  return {
    rootDir,
    userDir,
    storageStatePath: path.join(userDir, 'storage-state.json'),
    metaPath: path.join(userDir, 'meta.json'),
  };
}

/**
 * Pre-v1.18 layout: one flat `<userId>.json` per user directly under the
 * profile dir. Kept readable so an existing login survives the upgrade; new
 * checkpoints are still written to the hashed layout.
 */
function legacyStorageStatePath(profileDir, userId) {
  if (!profileDir) return null;
  return path.join(path.resolve(profileDir), `${safeUserSlug(userId)}.json`);
}

async function readStorageStateFile(filePath, logger = console) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.cookies)) return null;
    if (parsed.origins !== undefined && !Array.isArray(parsed.origins)) return null;
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    logger?.warn?.('failed to read persisted storage state', {
      storageStatePath: filePath,
      error: err?.message || String(err),
    });
    return null;
  }
}

async function loadPersistedStorageState(profileDir, userId, logger = console) {
  if (!profileDir) return undefined;

  const { storageStatePath } = getUserPersistencePaths(profileDir, userId);
  const hashed = await readStorageStateFile(storageStatePath, logger);
  if (hashed) return storageStatePath;

  const legacyPath = legacyStorageStatePath(profileDir, userId);
  if (legacyPath) {
    const legacy = await readStorageStateFile(legacyPath, logger);
    if (legacy) return legacyPath;
  }
  return undefined;
}

// Per-platform auth cookies. A jar is "authed for" a platform when every listed
// cookie name is present on a matching domain. Persistence refuses to overwrite
// a known-good authed jar with one that lost a platform, so a transient logout
// bounce can never destroy a real login.
const AUTH_COOKIE_REGISTRY = [
  { platform: 'linkedin', domain: /(^|\.)linkedin\.com$/, required: ['li_at'] },
  { platform: 'x', domain: /(^|\.)(x|twitter)\.com$/, required: ['auth_token'] },
  { platform: 'instagram', domain: /(^|\.)instagram\.com$/, required: ['sessionid'] },
  { platform: 'tiktok', domain: /(^|\.)tiktok\.com$/, required: ['sessionid'] },
  { platform: 'facebook', domain: /(^|\.)facebook\.com$/, required: ['c_user', 'xs'] },
  { platform: 'reddit', domain: /(^|\.)reddit\.com$/, required: ['reddit_session'] },
  { platform: 'youtube', domain: /(^|\.)(youtube|google)\.com$/, required: ['SID'] },
];

const MAX_JAR_COOKIES = 120;
const MAX_ORIGIN_LOCALSTORAGE_BYTES = 64 * 1024;
const MAX_ORIGINS = 60;

function cookieKey(cookie) {
  return `${cookie.name}|${cookie.domain}|${cookie.path || '/'}|${cookie.partitionKey || ''}`;
}

function isAuthCookie(cookie) {
  for (const entry of AUTH_COOKIE_REGISTRY) {
    if (!entry.domain.test(cookie.domain || '')) continue;
    if (entry.required.includes(cookie.name)) return true;
  }
  return false;
}

function authedPlatforms(cookies) {
  const out = new Set();
  for (const entry of AUTH_COOKIE_REGISTRY) {
    const names = new Set(
      (cookies || [])
        .filter((c) => entry.domain.test(c.domain || ''))
        .map((c) => c.name)
    );
    if (entry.required.every((name) => names.has(name))) out.add(entry.platform);
  }
  return out;
}

function slimOrigins(prior, state) {
  const measured = (state.origins || []).map((origin) => ({
    origin: origin.origin,
    localStorage: origin.localStorage || [],
    bytes: (origin.localStorage || []).reduce(
      (sum, entry) => sum + (entry.value ? entry.value.length : 0) + (entry.name ? entry.name.length : 0),
      0
    ),
  }));

  // Carry prior origins the live state did not report, so an unvisited site
  // keeps its small-but-useful state.
  const seen = new Set(measured.map((origin) => origin.origin));
  for (const origin of prior?.origins || []) {
    if (!seen.has(origin.origin)) {
      measured.push({ origin: origin.origin, localStorage: origin.localStorage || [], bytes: 0, carried: true });
    }
  }

  const kept = [];
  for (const origin of measured) {
    if (origin.localStorage.length > 0) {
      // Drop the largest entries first until the origin fits its budget.
      const entries = [...origin.localStorage].sort(
        (a, b) => (b.value ? b.value.length : 0) - (a.value ? a.value.length : 0)
      );
      let bytes = entries.reduce(
        (sum, entry) => sum + (entry.value ? entry.value.length : 0) + (entry.name ? entry.name.length : 0),
        0
      );
      while (bytes > MAX_ORIGIN_LOCALSTORAGE_BYTES && entries.length > 0) {
        const entry = entries.shift();
        bytes -= (entry.value ? entry.value.length : 0) + (entry.name ? entry.name.length : 0);
      }
      origin.localStorage = entries;
      origin.bytes = bytes;
    }
    if (origin.localStorage.length > 0 || origin.carried) kept.push(origin);
  }

  kept.sort((a, b) => b.bytes - a.bytes);
  return kept.slice(0, MAX_ORIGINS).map((origin) => ({
    origin: origin.origin,
    localStorage: origin.localStorage,
  }));
}

/**
 * Merge the live jar, the storageState jar and the prior on-disk jar into one
 * bounded snapshot. `context.cookies()` is the jar authority: it carries
 * httpOnly and partitioned (CHIPS) cookies that storageState() can drop.
 * Still-valid prior cookies are carried over so a value that transiently
 * vanished mid-navigation is not lost. Live always wins on a key clash.
 *
 * Returns `{ state, written, reason?, authed? }`; throws nothing.
 */
function buildStorageState({ state, liveCookies, prior }) {
  const now = Date.now() / 1000;
  const map = new Map();

  for (const cookie of prior?.cookies || []) {
    if (cookie.expires === undefined || cookie.expires === -1 || cookie.expires > now) {
      map.set(cookieKey(cookie), cookie);
    }
  }
  for (const cookie of state?.cookies || []) map.set(cookieKey(cookie), cookie);
  for (const cookie of liveCookies || []) map.set(cookieKey(cookie), cookie);

  const authCookies = [...map.values()].filter((cookie) => isAuthCookie(cookie));
  const nonAuth = [...map.values()].filter((cookie) => !isAuthCookie(cookie));
  let merged = [...authCookies, ...nonAuth];
  if (merged.length > MAX_JAR_COOKIES) {
    const byExpiry = [...nonAuth].sort((a, b) => (b.expires || -1) - (a.expires || -1));
    const keepNonAuth = byExpiry.slice(0, Math.max(0, MAX_JAR_COOKIES - authCookies.length));
    merged = [...authCookies, ...keepNonAuth];
  }

  // Compare the LIVE jar against the prior file, not against the merge: the
  // merge carries unexpired prior cookies, so it can never "lose" a platform.
  // The gate exists to keep a transiently logged-out jar from overwriting a
  // known-good authed one on disk.
  if (prior) {
    const liveAuth = authedPlatforms([...(state?.cookies || []), ...(liveCookies || [])]);
    const lost = [...authedPlatforms(prior.cookies)].filter((platform) => !liveAuth.has(platform));
    if (lost.length) return { written: false, reason: 'auth-downgrade', lost };
  }

  const snapshot = { cookies: merged };
  if ((state && Object.prototype.hasOwnProperty.call(state, 'origins')) || prior?.origins) {
    snapshot.origins = slimOrigins(prior, state || {});
  }
  return {
    written: true,
    state: snapshot,
    authed: [...authedPlatforms(merged)],
  };
}

async function persistStorageState({
  profileDir,
  userId,
  context,
  storageState,
  logger = console,
  indexedDB = false,
}) {
  if (!profileDir || (!context && !storageState)) {
    return { persisted: false, reason: 'disabled' };
  }

  const { userDir, storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const tmpStoragePath = `${storageStatePath}${suffix}`;
  const tmpMetaPath = `${metaPath}${suffix}`;

  try {
    await fs.mkdir(userDir, { recursive: true });

    // An explicitly supplied snapshot (session:storage:export) is written
    // verbatim: the caller already serialized the browser and expects a
    // byte-for-byte copy. Only a live context is hardened (cookie merge, caps,
    // auth-downgrade gate).
    if (!context) {
      await fs.writeFile(tmpStoragePath, JSON.stringify(storageState, null, 2));
      await fs.rename(tmpStoragePath, storageStatePath);
      await fs.writeFile(
        tmpMetaPath,
        JSON.stringify(
          { userId: String(userId), updatedAt: new Date().toISOString(), storageStatePath },
          null,
          2
        )
      );
      await fs.rename(tmpMetaPath, metaPath);
      return { persisted: true, userDir, storageStatePath, metaPath };
    }

    const stateOptions = { path: tmpStoragePath };
    if (indexedDB) stateOptions.indexedDB = true;
    await context.storageState(stateOptions);
    const state = (await readStorageStateFile(tmpStoragePath, logger)) || { cookies: [], origins: [] };

    let liveCookies = [];
    try {
      liveCookies = await context.cookies();
    } catch {
      liveCookies = [];
    }

    const prior =
      (await readStorageStateFile(storageStatePath, logger))
      || (await readStorageStateFile(legacyStorageStatePath(profileDir, userId), logger));

    const built = buildStorageState({ state, liveCookies, prior });
    if (!built.written) {
      await fs.unlink(tmpStoragePath).catch(() => {});
      return { persisted: false, reason: built.reason, lost: built.lost };
    }

    await fs.writeFile(tmpStoragePath, JSON.stringify(built.state, null, 2));
    await fs.rename(tmpStoragePath, storageStatePath);
    await fs.writeFile(
      tmpMetaPath,
      JSON.stringify(
        {
          userId: String(userId),
          updatedAt: new Date().toISOString(),
          storageStatePath,
          authed: built.authed,
        },
        null,
        2
      )
    );
    await fs.rename(tmpMetaPath, metaPath);
    return { persisted: true, userDir, storageStatePath, metaPath, authed: built.authed };
  } catch (err) {
    await fs.unlink(tmpStoragePath).catch(() => {});
    await fs.unlink(tmpMetaPath).catch(() => {});
    logger?.warn?.('failed to persist storage state', {
      userId: String(userId),
      storageStatePath,
      error: err?.message || String(err),
    });
    return { persisted: false, reason: 'error', error: err };
  }
}

/**
 * Re-inject a persisted jar into a just-created context. storageState restore
 * can skip partitioned cookies, so the full jar is added explicitly. Best
 * effort per cookie; only the actionable "on disk but not in context" case is
 * logged.
 */
async function restoreCookiesIntoContext(context, storageStatePath, logger = console) {
  if (!context || !storageStatePath) return { restored: 0 };
  const saved = await readStorageStateFile(storageStatePath, logger);
  if (!saved || !Array.isArray(saved.cookies) || saved.cookies.length === 0) return { restored: 0 };

  try {
    await context.addCookies(saved.cookies).catch(async (err) => {
      logger?.warn?.('addCookies batch failed, per-cookie fallback', { error: err?.message || String(err) });
      for (const cookie of saved.cookies) {
        await context.addCookies([cookie]).catch((cookieErr) => {
          logger?.warn?.('addCookie skipped', {
            name: cookie.name,
            error: cookieErr?.message || String(cookieErr),
          });
        });
      }
    });
    const restoredNames = new Set((await context.cookies().catch(() => [])).map((cookie) => cookie.name));
    const dropped = saved.cookies.filter((cookie) => !restoredNames.has(cookie.name)).map((cookie) => cookie.name);
    if (dropped.length) {
      logger?.warn?.('cookies not restored into context', { dropped: [...new Set(dropped)] });
    }
    return { restored: saved.cookies.length };
  } catch (err) {
    logger?.warn?.('cookie restore failed', { error: err?.message || String(err) });
    return { restored: 0 };
  }
}

export {
  getUserPersistencePaths,
  legacyStorageStatePath,
  loadPersistedStorageState,
  persistStorageState,
  readStorageStateFile,
  restoreCookiesIntoContext,
};
