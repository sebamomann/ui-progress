/**
 * How the history was made: every snapshot attempt, every snapshot batch, and every agent
 * task the agent reports, one JSON line each in .ui-progress/runs.jsonl. Unlike the
 * screenshots, this file is committed: it is the only record of what a rebuild costs and
 * where it went wrong.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION } from "./util.mjs";

export const runsFile = (p) => path.join(p.root, "runs.jsonl");

/** Append one record. Parallel snapshot workers append to the same file; each line is one write. */
export function appendRun(p, record) {
  fs.mkdirSync(p.root, { recursive: true });
  fs.appendFileSync(runsFile(p), JSON.stringify({ at: new Date().toISOString(), version: VERSION, ...record }) + "\n");
}

/** Every record, oldest first. A line that does not parse (a merge conflict, a cut-off write) is skipped. */
export function readRuns(p) {
  if (!fs.existsSync(runsFile(p))) return [];
  const out = [];
  for (const line of fs.readFileSync(runsFile(p), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const hashOf = (file) => (fs.existsSync(file) ? crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 10) : null);

/** The files that decide how a snapshot is made. A change between two attempts on one commit is a fix. */
export function setupFingerprint(p) {
  const adapterDir = path.join(p.root, "adapter");
  const parts = [p.adapter, ...(fs.existsSync(adapterDir) ? fs.readdirSync(adapterDir, { recursive: true }).map((f) => path.join(adapterDir, String(f))).filter((f) => fs.statSync(f).isFile()).sort() : [])];
  const adapter = crypto.createHash("sha1");
  for (const file of parts) if (fs.existsSync(file)) adapter.update(path.relative(p.root, file)).update(fs.readFileSync(file));
  return { adapter: adapter.digest("hex").slice(0, 10), config: hashOf(p.config), screens: hashOf(p.screens) };
}

export function machine() {
  const cpus = os.cpus();
  return { platform: os.platform(), arch: os.arch(), cpus: cpus.length, cpu: cpus[0]?.model?.trim() ?? null, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version };
}

/** Screenshot files in a capture manifest, copied-forward pages included. */
export function shotCount(manifest) {
  let n = 0;
  for (const route of manifest.routes ?? []) {
    for (const variant of Object.values(route.variants ?? {})) {
      n += Object.keys(variant.files ?? {}).length;
      for (const state of variant.states ?? []) n += Object.keys(state.files ?? {}).length;
    }
  }
  return n;
}
