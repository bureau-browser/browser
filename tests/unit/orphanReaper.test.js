import { createChildTracker, parsePs } from '../../lib/orphan-reaper.js';

const SERVER = 500;

function makeWorld(initial) {
  const world = { procs: [...initial], signals: [] };
  const list = async () => world.procs.map((p) => ({ ...p }));
  const kill = (pid, sig) => {
    world.signals.push([pid, sig]);
    if (sig === 'SIGKILL' || world.dieOnTerm?.has(Math.abs(pid))) {
      world.procs = world.procs.filter((p) => p.pid !== Math.abs(pid));
    }
  };
  return { world, list, kill };
}

const camoufox = (pid, extra = {}) => ({ pid, ppid: SERVER, pgid: pid, command: '/Users/x/Library/Caches/camoufox/Camoufox.app/Contents/MacOS/camoufox -no-remote', ...extra });

describe('parsePs', () => {
  test('parses pid ppid pgid command', () => {
    const rows = parsePs('  101     1   101 /usr/bin/foo --bar\n  202   101   202 camoufox -headless\n');
    expect(rows).toEqual([
      { pid: 101, ppid: 1, pgid: 101, command: '/usr/bin/foo --bar' },
      { pid: 202, ppid: 101, pgid: 202, command: 'camoufox -headless' },
    ]);
  });
});

describe('createChildTracker', () => {
  test('reapSince only touches new camoufox children of this server', async () => {
    const { world, list, kill } = makeWorld([
      camoufox(11),
      camoufox(12, { ppid: 999 }),
      { pid: 13, ppid: SERVER, pgid: 13, command: 'node helper.js' },
    ]);
    const tracker = createChildTracker({ ppid: SERVER, list, kill, sleep: async () => {}, graceMs: 0 });
    const baseline = await tracker.begin();
    expect([...baseline]).toEqual([11]);

    world.procs.push(camoufox(21), camoufox(22, { ppid: 1 }));
    world.dieOnTerm = new Set([21]);
    const reaped = await tracker.reapSince(baseline);

    expect(reaped).toEqual([21]);
    expect(world.signals).toEqual([[-21, 'SIGTERM']]);
    expect(world.procs.map((p) => p.pid).sort()).toEqual([11, 12, 13, 22]);
  });

  test('escalates to SIGKILL when a child survives SIGTERM', async () => {
    const { world, list, kill } = makeWorld([]);
    const tracker = createChildTracker({ ppid: SERVER, list, kill, sleep: async () => {}, graceMs: 0 });
    const baseline = await tracker.begin();
    world.procs.push(camoufox(31));
    await tracker.reapSince(baseline);
    expect(world.signals).toEqual([[-31, 'SIGTERM'], [-31, 'SIGKILL']]);
    expect(world.procs).toEqual([]);
  });

  test('signals the pid, not the group, when the child is not a group leader', async () => {
    const { world, list, kill } = makeWorld([]);
    const tracker = createChildTracker({ ppid: SERVER, list, kill, sleep: async () => {}, graceMs: 0 });
    const baseline = await tracker.begin();
    world.procs.push(camoufox(41, { pgid: 7 }));
    world.dieOnTerm = new Set([41]);
    await tracker.reapSince(baseline);
    expect(world.signals).toEqual([[41, 'SIGTERM']]);
  });

  test('reapCurrent kills only adopted pids that are still our children (pid reuse safe)', async () => {
    const { world, list, kill } = makeWorld([]);
    const tracker = createChildTracker({ ppid: SERVER, list, kill, sleep: async () => {}, graceMs: 0 });
    const baseline = await tracker.begin();
    world.procs.push(camoufox(51), camoufox(52));
    await tracker.adopt(baseline);
    expect(tracker.trackedPids().sort()).toEqual([51, 52]);

    world.procs = world.procs.filter((p) => p.pid !== 52);
    world.procs.push({ pid: 52, ppid: 1, pgid: 52, command: '/usr/bin/unrelated' });
    world.dieOnTerm = new Set([51]);

    const reaped = await tracker.reapCurrent();
    expect(reaped).toEqual([51]);
    expect(world.signals.some(([pid]) => Math.abs(pid) === 52)).toBe(false);
    expect(tracker.trackedPids()).toEqual([]);
  });

  test('reapCurrent is a no-op (no ps call) when nothing was adopted', async () => {
    let listed = 0;
    const tracker = createChildTracker({ ppid: SERVER, list: async () => { listed++; return []; }, kill: () => {}, sleep: async () => {} });
    expect(await tracker.reapCurrent()).toEqual([]);
    expect(listed).toBe(0);
  });

  test('a clean close leaves nothing to signal', async () => {
    const { world, list, kill } = makeWorld([]);
    const tracker = createChildTracker({ ppid: SERVER, list, kill, sleep: async () => {}, graceMs: 0 });
    const baseline = await tracker.begin();
    world.procs.push(camoufox(61));
    await tracker.adopt(baseline);
    world.procs = [];
    expect(await tracker.reapCurrent()).toEqual([]);
    expect(world.signals).toEqual([]);
  });
});
