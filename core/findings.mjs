/**
 * Findings: problems with ui-progress itself (bugs, gaps, workarounds) noticed while using
 * it. They are written into the project so they can be sent to the plugin's maintainer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VERSION, readJson, writeJson } from "./util.mjs";

const KINDS = ["bug", "limitation", "workaround", "idea", "failure"];

export function addFinding(p, { kind = "bug", title, detail = "", command = null, sha = null, phase = null, log = null, source = "agent" }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  if (!title) throw new Error("a finding needs a --title");
  const now = new Date();
  const id = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}`;
  const finding = {
    id,
    kind,
    title,
    detail,
    command,
    sha,
    phase,
    log,
    source,
    status: "open",
    createdAt: now.toISOString(),
    environment: { uiProgress: VERSION, node: process.version, platform: `${os.platform()} ${os.release()}`, arch: os.arch() },
  };
  writeJson(path.join(p.findings, `${id}.json`), finding);
  return finding;
}

export function listFindings(p) {
  if (!fs.existsSync(p.findings)) return [];
  return fs
    .readdirSync(p.findings)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(p.findings, f)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** One Markdown file with every open finding, ready to paste into an issue or an email. */
export function exportFindings(p, projectName) {
  const findings = listFindings(p).filter((f) => f.status === "open");
  const lines = [`# ui-progress findings`, "", `Project: ${projectName}`, `Exported: ${new Date().toISOString()}`, `Open findings: ${findings.length}`, ""];
  for (const f of findings) {
    lines.push(`## [${f.kind}] ${f.title}`, "", `- id: \`${f.id}\``, `- recorded: ${f.createdAt} by ${f.source}`);
    lines.push(`- environment: ui-progress ${f.environment.uiProgress}, node ${f.environment.node}, ${f.environment.platform} (${f.environment.arch})`);
    if (f.command) lines.push(`- command: \`${f.command}\``);
    if (f.sha) lines.push(`- commit: \`${f.sha}\`${f.phase ? ` (phase: ${f.phase})` : ""}`);
    lines.push("", f.detail || "_no detail given_", "");
    if (f.log) lines.push("```", f.log, "```", "");
  }
  const file = path.join(p.findings, "REPORT.md");
  fs.mkdirSync(p.findings, { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  return { file, count: findings.length };
}

export function resolveFinding(p, id) {
  const file = path.join(p.findings, `${id}.json`);
  const finding = readJson(file);
  if (!finding) throw new Error(`no finding ${id}`);
  finding.status = "resolved";
  writeJson(file, finding);
}
