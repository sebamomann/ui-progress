/**
 * The two native dependencies (Playwright, sharp) live outside the plugin, in a directory
 * that survives plugin updates. `ui-progress doctor --install` fills it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const DEPS_DIR = process.env.UI_PROGRESS_DEPS ?? path.join(os.homedir(), ".ui-progress", "deps");
export const PACKAGES = ["playwright@^1.50.0", "sharp@^0.33.0"];

function load(name) {
  const anchor = path.join(DEPS_DIR, "package.json");
  if (!fs.existsSync(anchor)) return null;
  try {
    return createRequire(anchor)(name);
  } catch {
    return null;
  }
}

export function requireDep(name) {
  const mod = load(name);
  if (!mod) {
    throw new Error(`Missing dependency "${name}". Run: ui-progress doctor --install`);
  }
  return mod;
}

export const hasDep = (name) => load(name) !== null;
