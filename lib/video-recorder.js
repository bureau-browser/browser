/**
 * Tab video recorder.
 *
 * Playwright's native recordVideo path is Chromium-only; on Camoufox/Firefox
 * (Juggler) it either throws or produces a near-empty file. Two backends are
 * supported instead, picked per host:
 *
 *  - frame-grab (default, cross-platform): screenshot the page on a timer,
 *    then let ffmpeg assemble the PNGs into a single .webm at stop().
 *  - x11grab (opt-in, CAMOFOX_X11GRAB=1): ffmpeg reads a real X display. Only
 *    useful when the browser renders to a real-sized framebuffer; Camoufox's
 *    own Xvfb is 1x1, so this is off by default.
 *
 * All child_process usage lives here, matching the project's code-separation
 * rule (route handlers never spawn subprocesses directly).
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

function x11GrabAvailable(activeDisplay) {
  return (
    process.platform === 'linux' &&
    Boolean(activeDisplay) &&
    process.env.CAMOFOX_X11GRAB === '1'
  );
}

/**
 * Off-display recorder: snapshot the page on a timer into PNG frames, then
 * ffmpeg-assemble them into `videoPath` at stop(). A frame that fails
 * (navigation in flight, page closing) is skipped, and a single-flight guard
 * drops ticks while a screenshot is still running rather than queueing.
 *
 * Returns `{ videoPath, stop(), frameCount() }`. `stop()` is idempotent and
 * resolves once the .webm exists (or undefined when no frames were captured).
 */
function startFrameRecorder({ page, videoDir, videoPath, tabId, fps, scale = [], log = () => {} }) {
  const framesDir = path.join(videoDir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const intervalMs = Math.max(50, Math.round(1000 / Math.max(1, fps)));
  let frameCount = 0;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const buf = await page.screenshot({ type: 'png' });
      if (!stopped) {
        const name = `frame-${String(frameCount).padStart(6, '0')}.png`;
        fs.writeFileSync(path.join(framesDir, name), buf);
        frameCount++;
      }
    } catch {
      // page mid-navigation or closing - skip this frame.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  let stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearInterval(timer);
    stopPromise = (async () => {
      // Let an in-flight screenshot land before assembling.
      for (let i = 0; busy && i < 20; i++) await new Promise((r) => setTimeout(r, 50));
      if (frameCount === 0) {
        log('warn', 'frame recorder produced no frames', { tabId });
        return undefined;
      }
      await new Promise((resolve) => {
        const proc = spawn(
          'ffmpeg',
          [
            '-loglevel', 'warning',
            '-framerate', String(Math.max(1, fps)),
            '-i', path.join(framesDir, 'frame-%06d.png'),
            ...scale,
            '-c:v', 'libvpx',
            '-b:v', '1M',
            '-pix_fmt', 'yuv420p',
            '-y',
            videoPath,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        proc.stderr?.on('data', (b) => {
          const m = b.toString().trim();
          if (m) log('warn', 'ffmpeg assemble stderr', { tabId, msg: m.slice(0, 200) });
        });
        proc.on('exit', () => resolve());
        proc.on('error', () => resolve());
      });
      fs.rmSync(framesDir, { recursive: true, force: true });
      return videoPath;
    })();
    return stopPromise;
  };
  return { videoPath, stop, frameCount: () => frameCount };
}

/** x11grab backend: ffmpeg captures an X display until SIGINT. */
function startX11Grab({ videoPath, tabId, width, height, fps, scale = [], display, log = () => {} }) {
  const proc = spawn(
    'ffmpeg',
    [
      '-loglevel', 'warning',
      '-f', 'x11grab',
      '-video_size', `${width}x${height}`,
      '-framerate', String(fps),
      '-i', display,
      ...scale,
      '-c:v', 'libvpx',
      '-b:v', '1M',
      '-cpu-used', '4',
      '-deadline', 'realtime',
      '-y',
      videoPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  proc.stderr?.on('data', (buf) => {
    const msg = buf.toString().trim();
    if (msg) log('warn', 'ffmpeg stderr', { tabId, msg: msg.slice(0, 200) });
  });
  proc.on('exit', (code, signal) => {
    log('info', 'ffmpeg exited', { tabId, code, signal });
  });
  return proc;
}

/**
 * SIGINT an x11grab ffmpeg and wait for it to exit. SIGINT matters: SIGKILL
 * leaves the WebM container without a trailer/index, which most players
 * refuse to open. Escalates to SIGKILL only if it refuses to die.
 */
function stopFfmpegAndWait(proc, { tabId, reason, timeoutMs = 5000, log = () => {} } = {}) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let killer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve();
    };
    proc.once('exit', finish);
    proc.once('close', finish);
    try {
      proc.kill('SIGINT');
    } catch {
      finish();
      return;
    }
    killer = setTimeout(() => {
      if (settled) return;
      log('warn', 'ffmpeg SIGINT timed out, escalating to SIGKILL', { tabId, reason });
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs);
  });
}

export { x11GrabAvailable, startFrameRecorder, startX11Grab, stopFfmpegAndWait };
