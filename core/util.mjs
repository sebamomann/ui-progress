/** Small shared helpers: shell execution, git, logging, argument parsing. */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";

export const VERSION = "0.6.0";

export function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Run a shell command, streaming output to `log` (a file path). Rejects on a non-zero exit. */
export function sh(command, { cwd, env, log, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const out = log ? fs.openSync(log, "a") : "inherit";
    if (log) fs.writeSync(out, `\n$ ${command}\n`);
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (log) fs.closeSync(out);
      if (code === 0) resolve();
      else reject(new Error(`command failed (${signal ?? "exit " + code}): ${command}`));
    });
  });
}

/** Start a long-running command in its own process group. Returns a function that stops it. */
export function background(command, { cwd, env, log }) {
  const out = fs.openSync(log, "a");
  const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
  let exited = false;
  child.on("exit", () => (exited = true));
  return {
    exited: () => exited,
    stop: () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 3000).unref();
    },
  };
}

/** Whether nothing listens on `port`, on IPv4 or IPv6. */
async function portFree(port) {
  for (const host of ["127.0.0.1", "::"]) {
    const ok = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (err) => resolve(err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT"));
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
    });
    if (!ok) return false;
  }
  return true;
}

/** `port` if it is free, else the first free one of port+32, port+64, ... (parallel slots stay apart). */
export async function freePort(port) {
  for (let k = 0; k < 40; k++) if (await portFree(port + k * 32)) return port + k * 32;
  throw new Error(`no free port found from ${port} upwards`);
}

export async function waitForHttp(url, { timeoutMs = 180_000, alive = () => true } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!alive()) throw new Error("the app exited before it answered");
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`the app did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s`);
}

export function tail(file, lines = 40) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
}

/** `--flag value`, `--flag=value`, `--bool`, and positionals. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { flags, positional };
}

export const readJson = (file, fallback = null) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Print rows as an aligned table. */
export function table(rows) {
  if (!rows.length) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}
