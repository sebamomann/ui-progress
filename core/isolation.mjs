/**
 * Data isolation: snapshots build their own dataset in throwaway databases and never touch
 * the project's real ones (development, test, anything in its env files), unless the
 * project's config says `data.isolation: "shared"`.
 *
 * The protected databases are read from the live repository's env files. Every command an
 * adapter runs through ctx.exec, and the app it starts, is checked against them: its
 * environment, the env files in the checkout, and config files in the checkout that hold a
 * literal connection string (old commits often hardcode one).
 */
import fs from "node:fs";
import path from "node:path";
import { git } from "./util.mjs";

const URL_RE = /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|mssql|sqlserver|cockroachdb):\/\/[^\s"'`]+/gi;
const SQLITE_RE = /\b(?:file|sqlite):[^\s"'`]+\.(?:db|sqlite3?)\b/gi;
const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "host.docker.internal"]);
const DEFAULT_PORT = { postgres: 5432, postgresql: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379, rediss: 6379, mssql: 1433, sqlserver: 1433, cockroachdb: 26257 };
const CONFIG_FILE = /(^|\/)(\.env[^/]*|[^/]*\.config\.(c|m)?(j|t)s|[^/]*config[^/]*\.(json|ya?ml|toml|ini)|docker-compose[^/]*\.ya?ml|settings[^/]*\.py|database\.ya?ml|schema\.prisma|prisma\.config\.(c|m)?(j|t)s|knexfile\.(c|m)?(j|t)s|ormconfig\.[a-z]+|drizzle\.config\.[a-z]+|alembic\.ini|appsettings[^/]*\.json)$/i;

/** A comparable identity for a database: scheme://host:port/name, local hosts folded together. */
export function identity(value) {
  if (/^(file|sqlite):/i.test(value)) return `sqlite:${path.basename(value.replace(/^(file|sqlite):/i, "").split("?")[0])}`;
  try {
    const u = new URL(value);
    const scheme = u.protocol.replace(/:$/, "").toLowerCase().replace("postgresql", "postgres");
    const host = LOCAL.has(u.hostname) ? "local" : u.hostname.toLowerCase();
    const port = u.port || DEFAULT_PORT[scheme] || "";
    const name = decodeURIComponent(u.pathname.replace(/^\//, "").split("/")[0]);
    return `${scheme}://${host}:${port}/${name}`;
  } catch {
    return null;
  }
}

export const redact = (value) => value.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@");

function connectionStrings(text) {
  return [...(text.match(URL_RE) ?? []), ...(text.match(SQLITE_RE) ?? [])].map((s) => s.replace(/[),;]+$/, ""));
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** "postgres:appdb" for a database on this machine, matched whatever the port. */
const localName = (id) => {
  const m = /^([a-z+]+):\/\/local:\d*\/(.+)$/.exec(id ?? "");
  return m ? `${m[1]}:${m[2]}` : null;
};

/**
 * The project's own databases: every connection string in its env files, in any tracked
 * file of the repository (scripts, compose files, old defaults), database names declared
 * for containers, the user's shell, and config `data.protect`.
 */
export function protectedDatabases(repo, config) {
  const found = new Map();
  const add = (value, source) => {
    const id = identity(value);
    if (id && !id.endsWith("/") && !found.has(id)) found.set(id, { id, value: redact(value), source });
  };
  for (const name of fs.readdirSync(repo)) {
    if (!/^\.env/.test(name) || /\.(example|sample|template|dist)$/.test(name)) continue;
    const file = path.join(repo, name);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const value of Object.values(parseEnv(text))) for (const s of connectionStrings(value)) add(s, name);
  }
  // Tracked files: connection strings, and container database names.
  try {
    const grep = git(repo, "grep", "-I", "-h", "-o", "-E", "(postgres(ql)?|mysql|mariadb|mongodb(\\+srv)?|redis|mssql|cockroachdb)://[^[:space:]\"'`]+|(POSTGRES_DB|MYSQL_DATABASE|MARIADB_DATABASE|MONGO_INITDB_DATABASE)[\"']?[:=][[:space:]]*[\"']?[A-Za-z0-9_-]+", "--", ".", ":!*.md", ":!*.lock", ":!package-lock.json", ":!.ui-progress");
    for (const line of grep.split("\n").filter(Boolean)) {
      const container = /(POSTGRES_DB|MYSQL_DATABASE|MARIADB_DATABASE|MONGO_INITDB_DATABASE)["']?[:=]\s*["']?([A-Za-z0-9_-]+)/.exec(line);
      if (container) {
        const scheme = { POSTGRES_DB: "postgres", MYSQL_DATABASE: "mysql", MARIADB_DATABASE: "mariadb", MONGO_INITDB_DATABASE: "mongodb" }[container[1]];
        add(`${scheme}://localhost/${container[2]}`, "a container definition in the repository");
      } else for (const s of connectionStrings(line)) if (!/[<{$]|example|placeholder/i.test(s)) add(s, "a file in the repository");
    }
  } catch {
    // no git grep hits
  }
  for (const value of config.data?.protect ?? []) add(value, "config data.protect");
  // The user's own shell may point at a real database too.
  for (const [key, value] of Object.entries(process.env)) if (/DATABASE|_URL$|_URI$|DSN/i.test(key)) for (const s of connectionStrings(String(value))) add(s, `shell $${key}`);
  return [...found.values()];
}

function walk(dir, base, depth, out) {
  if (depth < 0 || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".next", "dist", "build", ".venv", "venv", "__pycache__", "vendor", ".ui-progress"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, depth - 1, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/**
 * Throws when the environment, or a config/env file in the checkout, points at a protected
 * database. `where` names the step for the message.
 */
export function assertIsolated({ config, protectedDbs, env = {}, checkout = null, where }) {
  if ((config.data?.isolation ?? "throwaway") === "shared" || !protectedDbs.length) return;
  const ids = new Map(protectedDbs.map((d) => [d.id, d]));
  const names = new Map(protectedDbs.filter((d) => localName(d.id)).map((d) => [localName(d.id), d]));
  const match = (id) => ids.get(id) ?? names.get(localName(id));
  const hits = [];
  for (const [key, value] of Object.entries(env)) {
    for (const s of connectionStrings(String(value ?? ""))) {
      const hit = match(identity(s));
      if (hit) hits.push({ db: hit, text: `environment variable ${key} = ${redact(s)}` });
    }
  }
  if (checkout) {
    for (const file of walk(checkout, checkout, 3, [])) {
      if (!CONFIG_FILE.test(file) || /\.(example|sample|template|dist)$/i.test(file)) continue;
      const full = path.join(checkout, file);
      if (fs.statSync(full).size > 300_000) continue;
      for (const s of connectionStrings(fs.readFileSync(full, "utf8"))) {
        const hit = match(identity(s));
        if (hit) hits.push({ db: hit, text: `${file} contains ${redact(s)}` });
      }
    }
  }
  if (!hits.length) return;
  const db = hits[0].db;
  throw new Error(
    `Refusing to ${where}: it would use one of the project's own databases (${db.value}, from ${db.source}).\n` +
      hits.map((h) => `  - ${h.text}`).join("\n") +
      `\nSnapshots build their own data in a throwaway database. Point the adapter at a database named after the snapshot ` +
      `(for example uiprog_<short sha>), rewrite literal connection strings in the checkout before running commands, ` +
      `and drop it in teardown. Only if the user explicitly wants their real data used, set "data": { "isolation": "shared" } in .ui-progress/config.json.`,
  );
}
