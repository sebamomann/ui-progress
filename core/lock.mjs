/**
 * One run at a time per repository. Two runs on the same repository share checkouts,
 * throwaway databases and snapshot folders, and break each other in ways that look like
 * adapter failures. The worker processes of a parallel run inherit the holder's lock.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./util.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Take the repository's lock, or throw naming the run that holds it. Returns a release function. */
export function acquireLock(p, command) {
  const file = path.join(p.root, ".lock");
  if (process.env.UI_PROGRESS_LOCK === file) return () => {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString(), version: VERSION, plugin: ROOT }, null, 2), { flag: "wx" });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // unreadable: treat as stale
      }
      if (holder && alive(holder.pid)) {
        throw new Error(
          `Another ui-progress run is working on this repository: pid ${holder.pid}, \`${holder.command}\`, started ${holder.startedAt}, ui-progress ${holder.version} (${holder.plugin}).\n` +
            `Two runs would share checkouts, throwaway databases and snapshot folders. Wait for it to finish, or stop that process. ` +
            `If it is gone, delete ${path.relative(p.repo, file)}.`,
        );
      }
      fs.rmSync(file, { force: true }); // left behind by a run that died
      if (attempt === 1) throw err;
    }
  }
  process.env.UI_PROGRESS_LOCK = file;
  const release = () => {
    try {
      if (JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { release(); process.exit(130); });
  return release;
}
