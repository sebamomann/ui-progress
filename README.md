# ui-progress

A Claude Code plugin that records how a website's UI evolved and lets you browse it.

You build a site for months and have no picture of what it used to look like, when a page
appeared, or which page another one grew out of. ui-progress rebuilds that from your git
history: it checks out old commits, runs them with seeded data, screenshots every page,
and works out the lineage of pages. From then on it keeps the record current as you work.

It is not tied to a framework or a subject. A Next.js plant tracker and a Django + React
property site use the same core; the difference is one small adapter file that Claude
writes for you when you set a project up.

## What you get

- **Every page at every chosen commit**, on desktop and mobile, signed out and signed in
- **Every view of a page**: sections you switch between, dialogs, menus, each tracked over time
- **Lineage**: which page was split off, extracted, merged, replaced or renamed, each with the evidence
- **A viewer** (one static HTML file) with a structural graph, a thumbnail timeline, per-snapshot overviews and a before/after slider
- **Seeded data and placeholder images** so old pages are not captured empty
- All of it stored in **`.ui-progress/` inside your repository**

## Quick start

```
claude plugin marketplace add sebamomann/ui-progress
claude plugin install ui-progress@ui-progress
```

Then, in Claude Code, in the repository you want to track:

> Set up ui-progress for this project and run a pilot.

Claude installs the screenshot dependencies, studies the project, writes the adapter,
tests it on three commits, captures about one commit per month, and opens the viewer.
When you like what you see, ask for more: "now one per week", or "you decide which
commits matter".

Full instructions: [docs/INSTALL.md](docs/INSTALL.md) and [docs/SETUP.md](docs/SETUP.md).

## How dense should the history be?

| Mode | Captures | Typical use |
| --- | --- | --- |
| `pilot` | one commit per month, at most 8 | see what you will get, in minutes |
| `monthly` / `weekly` / `daily` | the last commit of each period | steady cadence |
| `every-n` | every Nth commit | fixed density |
| `auto` | commits that added or removed a page, or changed a lot of UI code; Claude can refine the list | the meaningful history |
| `all` | every commit | small repositories |
| `manual` | exactly the commits you list | full control |

Switching to a denser mode only captures what is missing. Details and every other option
(viewports, what is never clicked, routes to skip, concurrency) are in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Commands

Run inside a Claude Code session, from the repository root. Claude runs these for you;
they are listed so you know what exists.

| Command | Does |
| --- | --- |
| `ui-progress doctor [--install]` | check or install Playwright, Chromium, sharp |
| `ui-progress init [--preset next-app\|next-pages\|crawl\|blank]` | create `.ui-progress/` |
| `ui-progress plan [--mode M] [--max N] [--from D] [--to D] [--print]` | choose the commits |
| `ui-progress snapshot --plan [--concurrency N] [--limit N] [--force]` | capture what is planned and missing |
| `ui-progress snapshot <sha…>` / `snapshot HEAD` | capture specific commits |
| `ui-progress snapshot --live <url>` | capture the app that is already running |
| `ui-progress status` | planned, done, failed |
| `ui-progress lineage candidates` / `lineage check` | evidence for lineage; validate `lineage.json` |
| `ui-progress build` / `view` | rebuild the viewer; rebuild and open it |
| `ui-progress instructions [--write]` | the capture rule for `AGENTS.md` / `CLAUDE.md`, for agents without the plugin |
| `ui-progress finding add\|list\|export\|resolve` | problems with the plugin itself |

## What lands in your repository

```
.ui-progress/
  config.json      sampling mode, viewports, limits            commit
  adapter.mjs      how to run this project at any commit       commit
  plan.json        the commits chosen                          commit
  lineage.json     splits, merges, renames, with evidence      commit
  findings/        problems with the plugin, to send upstream  optional
  snapshots/       screenshots and manifests per commit        ignored by default (20-40 MB each)
  viewer/          index.html and its data                     ignored by default
```

Old commits are checked out under `~/.ui-progress/work/`, outside the repository, and
removed after each snapshot. Your working tree and your git metadata are not touched.
Each snapshot uses its own throwaway database, created and dropped by the adapter.

## How it works

1. **Plan**: pick commits by mode.
2. **Snapshot**, per commit: check out → `install` → `seed` → `start` → capture → `teardown`.
3. **Capture**: visit every route signed out and signed in; keep both where they differ;
   wait until the page has stopped animating; then click through the page's controls and
   keep every click that opens a dialog or menu or switches the page to a different
   section. Destructive and state-changing buttons are never clicked.
4. **Lineage**: page lifetimes come from git; relationships come from Claude reading the
   commits that changed the set of pages, guided by evidence the tool collects (files
   moved or copied between page folders, pages that shrank in the same commit).
5. **Build**: thumbnails, visual change scores and the dataset for the viewer.

The project-specific part is the adapter: [docs/ADAPTERS.md](docs/ADAPTERS.md). A complete
one for Next.js, Prisma and Postgres is in
[examples/nextjs-prisma-postgres/](examples/nextjs-prisma-postgres/).

## Reporting problems

While Claude works with the plugin it records anything that is broken, missing or needed a
workaround in `.ui-progress/findings/`. Run `ui-progress finding export` and send
`.ui-progress/findings/REPORT.md` to the maintainer after reading it. Nothing is ever sent
automatically. See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for common failures.

## Limits worth knowing

- A full capture is slow: expect a few minutes per snapshot for a small site and well over
  ten for one with dozens of pages. Start with the pilot.
- Screenshots show seeded data and placeholder images, not your real content.
- Sections and dialogs are found by clicking; ones that need typed input, a hover, or two
  clicks are not found. Views are matched across time by their button label, so a
  relabelled button starts a new row.
- "Redesign" and "tweak" labels compare screenshots block by block; different seed data
  between two snapshots still counts as change.
- Lineage is a judgement, recorded with its evidence and a confidence. Review it.
- Only the mainline (first-parent) history of one branch is considered.

## Repository layout

```
.claude-plugin/   plugin and marketplace manifests
bin/ui-progress   the command
core/             generic engine: plan, snapshot, capture, lineage, build, findings
viewer/           the viewer (copied into each project on build)
templates/        files written by `init`
skills/           the skill that tells Claude how to use all this
hooks/            tell the agent a repository is tracked, and send it back to capture after UI changes
examples/         a complete adapter
docs/             guides
```

## License

MIT
