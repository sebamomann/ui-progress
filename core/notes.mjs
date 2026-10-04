/**
 * Project notes: .ui-progress/NOTES.md, what every agent working on this project's UI history
 * must know and respect (what the user asked for, what was found out the hard way). Kept by
 * the agents themselves; ui-progress only creates the file, prints it and points at it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "templates", "notes.md");

/** Create NOTES.md from the template when it is missing; true when it was created. */
export function ensureNotes(p) {
  if (fs.existsSync(p.notes)) return false;
  fs.mkdirSync(path.dirname(p.notes), { recursive: true });
  fs.copyFileSync(TEMPLATE, p.notes);
  return true;
}

/** The notes, by section: { text, sections: { "Capture": ["- ...", ...] }, count }. */
export function readNotes(p) {
  if (!fs.existsSync(p.notes)) return { text: null, sections: {}, count: 0 };
  const text = fs.readFileSync(p.notes, "utf8");
  const sections = {};
  let current = null;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) current = heading[1];
    else if (current && /^\s*[-*]\s+\S/.test(line) && !/^\s/.test(line)) (sections[current] ??= []).push(line);
  }
  return { text, sections, count: Object.values(sections).reduce((n, list) => n + list.length, 0) };
}

/** "3 project notes (Capture 2, Everywhere 1) in .ui-progress/NOTES.md", or null without any. */
export function notesLine(p) {
  const { count, sections } = readNotes(p);
  if (!count) return null;
  const parts = Object.entries(sections).map(([name, list]) => `${name} ${list.length}`).join(", ");
  return `${count} project note${count === 1 ? "" : "s"} (${parts}) in ${path.relative(p.repo, p.notes)}: read and follow them`;
}
