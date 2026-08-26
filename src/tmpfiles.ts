import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Backstop for temp files this process writes — backups and chart PNGs, all
 * of which are named `loopdog-*` in the OS temp directory.
 *
 * index.ts already unlinks the files it knows about in a finally block, but
 * that only covers paths that made it back out of respond(). A turn that
 * threw after a chart was written, or a crash mid-loop, leaves a file nobody
 * holds the name of any more. This sweeps those.
 *
 * Deliberately age-gated rather than "delete every loopdog-* file": a file
 * written moments ago may be seconds away from being attached to a reply.
 */
const PREFIX = "loopdog-";
const MAX_AGE_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let lastSweep = 0;

export async function sweepOldTempFiles(): Promise<number> {
  lastSweep = Date.now();
  const dir = tmpdir();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0; // an unreadable temp dir isn't worth failing a tick over
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // Raced with something else deleting it, or not ours to remove. Skip.
    }
  }
  return removed;
}

/** Rate-limited variant for the scheduler tick, which runs far more often than hourly. */
export async function sweepOldTempFilesIfDue(): Promise<void> {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  const removed = await sweepOldTempFiles();
  if (removed) console.log(`[loopdog] swept ${removed} stale temp file(s)`);
}
