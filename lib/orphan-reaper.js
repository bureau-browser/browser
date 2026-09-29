import { execFile } from 'child_process';

const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,command='];

function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
  }
  return rows;
}

function listProcesses() {
  return new Promise((resolve, reject) => {
    execFile('ps', PS_ARGS, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parsePs(stdout));
    });
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only pids that are still our direct children and still match at kill time are signalled (no pkill, no pid-reuse hits).
function createChildTracker({
  ppid = process.pid,
  match = /camoufox/i,
  list = listProcesses,
  kill = (pid, signal) => process.kill(pid, signal),
  sleep = defaultSleep,
  graceMs = 2000,
  log = () => {},
} = {}) {
  let current = new Set();

  async function ownChildren() {
    const rows = await list();
    return rows.filter((r) => r.ppid === ppid && match.test(r.command));
  }

  function signal(row, sig) {
    // Playwright spawns the browser as a process-group leader; signal the group so content processes go too.
    const target = row.pgid === row.pid ? -row.pid : row.pid;
    try {
      kill(target, sig);
      return true;
    } catch {
      return false;
    }
  }

  async function terminate(rows) {
    if (rows.length === 0) return [];
    const reaped = [];
    for (const row of rows) if (signal(row, 'SIGTERM')) reaped.push(row.pid);
    await sleep(graceMs);
    const survivors = new Set((await ownChildren()).map((r) => r.pid));
    for (const row of rows) if (survivors.has(row.pid)) signal(row, 'SIGKILL');
    return reaped;
  }

  async function begin() {
    return new Set((await ownChildren()).map((r) => r.pid));
  }

  async function adopt(baseline) {
    current = new Set((await ownChildren()).map((r) => r.pid).filter((pid) => !baseline.has(pid)));
  }

  async function reapSince(baseline) {
    const fresh = (await ownChildren()).filter((r) => !baseline.has(r.pid));
    const reaped = await terminate(fresh);
    if (reaped.length) log('warn', 'reaped orphan camoufox after failed launch', { pids: reaped });
    return reaped;
  }

  async function reapCurrent() {
    const tracked = current;
    current = new Set();
    if (tracked.size === 0) return [];
    const stragglers = (await ownChildren()).filter((r) => tracked.has(r.pid));
    const reaped = await terminate(stragglers);
    if (reaped.length) log('warn', 'reaped orphan camoufox after browser close', { pids: reaped });
    return reaped;
  }

  return { begin, adopt, reapSince, reapCurrent, trackedPids: () => [...current] };
}

export { createChildTracker, parsePs, listProcesses };
