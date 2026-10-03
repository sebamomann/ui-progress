---
name: history
description: Screenshot every page of a web app at past commits and see how its UI evolved — a visual timeline, before/after comparisons, and a graph of pages added, split, merged or renamed. Works with any web stack. Use to set up UI history tracking in a git repository, backfill it from old commits, capture the latest commit after UI changes, or record page lineage. Also use at the end of a session that committed UI changes, in a repository that has a .ui-progress/ folder.
---

# ui-progress

Records what every page of a web app looked like at chosen commits, works out how pages
relate over time, and builds a local viewer. Everything it produces lives in
`.ui-progress/` inside the user's repository.

The tool is the `ui-progress` command. It is on PATH while this plugin is enabled; if it
is not found, run it as `node "${CLAUDE_PLUGIN_ROOT}/bin/ui-progress"`. Run it from the
root of the user's repository. `ui-progress help` lists every command.

The core is generic. Everything specific to one project is in that project's
`.ui-progress/adapter.mjs`, which **you write** during setup. Read
`${CLAUDE_PLUGIN_ROOT}/docs/ADAPTERS.md` before writing one, and look at the worked
example in `${CLAUDE_PLUGIN_ROOT}/examples/nextjs-prisma-postgres/`.

## Pick the job

| The user wants | Do |
| --- | --- |
| To start tracking a project | [Set up](#set-up), then a pilot |
| More history, or the full history | [Backfill](#backfill) |
| To record what they just changed | [Capture the current state](#capture-the-current-state) |
| To know what split, merged or was renamed | [Lineage](#lineage) |
| To look at it | `ui-progress view` |
| Something in the tool is broken or missing | [Findings](#findings) |

## Set up

1. `ui-progress doctor`. If anything is missing, run `ui-progress doctor --install`
   (installs Playwright, Chromium and sharp into `~/.ui-progress/deps`, once per machine).
2. Study the project before asking anything: framework and router, how it is started, the
   database and how it is migrated and seeded, how sign-in works, where page files live,
   and how each of these **changed over the history** (`git log --diff-filter=A -- <file>`
   tells you when a seed script, a lockfile or a login page first appeared).
3. `ui-progress init --preset <next-app|next-pages|crawl|blank>`. If it lists the project's
   own tools (linters, formatters, dead-code or duplicate checkers, `tsconfig`) that would
   scan `.ui-progress/`, add the exclusions it names, so the project's checks keep passing;
   mention them to the user with the setup questions.
4. Write `.ui-progress/adapter.mjs` (with `export const requires = "<ui-progress version>"`,
   from `ui-progress version`) and adjust `.ui-progress/config.json`
   (`sampling.uiPaths` and `lineage.pagePaths` should name the folders that hold UI code).
5. Ask the user only what the repository cannot tell you, in one question round: which
   sampling mode (offer the pilot first); whether throwaway databases may be created on
   their local database server; and **which colour scheme matters** (light, dark, or both;
   the app's own default if they don't care). Store the answer as `colorScheme` on each
   viewport in `capture.viewports`; "both" means two viewports per size. Never ask twice:
   if the config already has it, use it.
6. Ask the user, in the same question round, whether to add the capture rule to the
   project's instructions file. The user should never have to know or type the command:
   you ask, explain, and run `ui-progress instructions --write` yourself on a yes.
   - Explain why in one or two sentences: with this plugin enabled, hooks already make
     Claude Code capture after UI changes, but anything that does not load the plugin
     (another coding agent, a teammate's setup, a cloud or CI session) will not know the
     history exists, and the record silently falls behind.
   - Say what it changes: one marked section in `AGENTS.md` (or `CLAUDE.md` if that is the
     only one), which is a committed file. Running it again updates the section in place.
   - Recommend yes when the repository shows signs of other agents or collaborators (an
     `AGENTS.md`, a `.codex/`, `.cursor/` or `.github/copilot-instructions.md`, several
     commit authors). For a solo project that only ever uses Claude Code with this plugin,
     say it is optional.
   - Record the answer in `config.json` as `"forward": { "instructionsFile": true }` or
     `false`, and do not ask again in a later session when the key is already set.
     `forward.mode` controls the hooks independently of this.
7. Prove the adapter on **three commits before anything bigger**: the newest, one from the
   middle, and the oldest that has real pages. `ui-progress snapshot <sha> <sha> <sha>`.
   Then open several screenshots from each and look at them (see
   [Check the result](#check-the-result)).

### Hand-picked screens: `.ui-progress/screens.json`

The automatic click-through finds dialogs, menus, tabs and sections that one or two clicks
away. Views that need a URL parameter, typed input or a precise sequence are listed in
`screens.json`, and **you write that file**; the user never has to. After the three test
commits, read the main pages' code for filters, view modes, search and URL parameters
(`searchParams`, `?status=`, `aria-pressed` toggles), and add an entry for each state that
matters to how the page looks:

```json
[
  { "id": "list-archived", "route": "/items", "label": "Archived items", "url": "/items?status=archived" },
  { "id": "list-search", "route": "/items", "label": "Search results",
    "steps": [{ "fill": { "selector": "input[type=search]", "value": "sample" } }, { "wait": 500 }] },
  { "id": "settings-notifications", "route": "/settings", "label": "Notifications tab", "steps": [{ "click": "text=Notifications" }] }
]
```

Steps: `click`, `hover`, `fill` (`{selector, value}`), `press`, `scroll` (pixels), `wait`
(ms); selectors are Playwright locators. `kind` defaults to `section`; use `dialog` for an
overlay. Prefer a `url` over clicks when the state is in the URL: it works in every era.
Verify the file on one snapshot (`run.log` lists every screen that failed) and fix the
selectors before the long run. Add to it whenever a later session adds a filter or a mode.

### Rules for the adapter

- **Never touch real data. This is the default and it is enforced.** Each snapshot builds
  its own dataset in a throwaway database named after the commit (`uiprog_<short sha>`),
  created in `seed` and dropped in `teardown`. ui-progress collects the project's own
  databases (every connection string in its env files and tracked files, container
  database names, the user's shell) and refuses to run a seed command or start the app
  when the environment, an env file or a config file in the checkout points at one of them.
  Copies of those connection strings in the checkout are replaced with an address that
  points nowhere right after checkout. Old commits often hardcode the connection in a file
  the app reads: call `ctx.rewriteDatabaseUrls(throwawayUrl)` in `seed` before the first
  command. Direct database clients in the adapter call `ctx.assertThrowaway(url)`.
  Make `seed` fail if the throwaway database ends up without tables. Only when the user
  explicitly asks for their real data to be used, set `"data": { "isolation": "shared" }`;
  never do it to get past a refusal.
- **Seed every feature.** A page captured in its empty state is a gap. Use the project's
  own seed where the commit has one, then fill every table it leaves empty. Write inserts
  that tolerate schema drift (insert only the columns that exist). After seeding, list the
  tables that are still empty and deal with each one that a page shows. "The project has
  no seed for this" is never a reason to skip a feature: write the seed.
- **Placeholder images.** Where the app shows photos, generate themed placeholder pictures
  for every record: different pictures for different records, and fitting the subject
  (products for a shop, rooms for a booking site, dishes for a recipe app, faces for
  avatars). Look at what the app shows to decide.
  Draw them as SVG and convert with `ctx.sharp`; never download images.
- **Dynamic routes.** `resolve(ctx)` must return a concrete URL for every route with a
  parameter that nothing links to, read from the seeded database.
- **Handle eras.** One adapter serves every commit. Branch on `ctx.has(file)` and
  `ctx.read(file)`, not on dates.
- Checkouts live outside the repository (`~/.ui-progress/work/`), because build tools walk
  up the folder tree and would pick up the live project's lockfile and config.

## Backfill

1. Choose the commits: `ui-progress plan --mode <mode>`, then show the user the table.

   | Mode | Picks | Use for |
   | --- | --- | --- |
   | `pilot` | last commit of each month, at most 8 | a first look in minutes |
   | `monthly`, `weekly`, `daily` | last commit of each period | a regular cadence |
   | `every-n` | every Nth commit (`sampling.everyN`) | fixed density |
   | `auto` | commits that added or removed a page, or where enough UI code changed | the meaningful history |
   | `all` | every commit | small repositories only |
   | `manual` | whatever is in `plan.json` | you or the user edit the list |

   `--max N`, `--from DATE`, `--to DATE` narrow any mode. In `auto` mode you may refine the
   plan yourself: `ui-progress plan --candidates` prints every commit with its UI churn and
   page changes; edit `.ui-progress/plan.json` to add commits that matter (a redesign that
   touched few lines) and drop ones that do not, then set `"mode": "manual"` in it so it is
   not regenerated.
2. Tell the user the size of the job before starting: number of snapshots, the measured
   time per snapshot from the three test commits, and the concurrency.
3. `ui-progress snapshot --plan` (resumable; `--concurrency N`, `--limit N`). For long runs
   start it in the background and check `ui-progress status`.
4. Failures are recorded automatically. Read `.ui-progress/snapshots/<sha>/run.log` and
   `server.log` (the failure line already quotes the first error found there), fix the
   adapter, rerun `ui-progress snapshot <sha>`. When the commit itself is broken and the
   failure names a fix-up commit (the next one, minutes later, same author), capture that
   one instead and swap it into `plan.json`. The same cause on many commits is one finding
   with every commit listed. Do not leave a failed snapshot unexplained.
5. Do the [lineage](#lineage) pass, then `ui-progress view`.

Going from a pilot to a denser history only captures the commits that are missing. A
snapshot added between two existing ones changes where lineage belongs: `ui-progress build`
places every edge at the first snapshot whose commit contains the edge's commit, so edges
with the right `sha` move on their own. It also checks each edge against what the snapshots
show, and re-places edges the new snapshot contradicts (the pages of a split already exist
before the recorded commit, or a merged page still renders after it). Follow every build
that added snapshots with `ui-progress lineage check`, and resolve what it reports (see
[Lineage](#lineage)).

### How long it takes

Several pages are captured at once (`capture.parallel`, default 3 tabs). A page whose
source files did not change since the previous captured commit is copied forward instead of
re-shot (`capture.incremental`); the log line `incremental: … pages unchanged` says how many.
That needs `routeOfFile` in the adapter and an import graph the resolver can follow (JS/TS
with relative or tsconfig-alias imports). A change in `globalPaths` (package.json, config
files, global CSS, public assets) recaptures everything; translation JSON files only affect
the pages that use a changed namespace. Mention the measured time per snapshot from the
three test commits when you quote a duration.

## Capture the current state

Snapshots are always of a **commit**, checked out and run with a throwaway database.
There is no way to capture uncommitted changes or an app that is already running.

A hook sends you here when a session committed UI changes and is about to end without a
capture. Decide first whether anything visible changed; if not, say so in one line and
stop.

**Capture once per batch, at the end.** A task often spans several commits (a feature in
steps, a refactor across many files). Do not capture after each of them: when the last
commit of the task is made, one snapshot of HEAD covers the whole batch.

1. `ui-progress pending` says whether HEAD is captured, which commits since the last
   snapshot a capture of HEAD would cover, and whether UI changes are still uncommitted.
2. If UI work is still uncommitted and committing is part of the task, commit it first, in
   small, focused commits (one change each), so the history shows what changed when. If
   committing is not part of the task, do not commit on the user's behalf: tell them in one
   line that a capture is due once they commit.
3. `ui-progress snapshot HEAD`. This is fast: pages whose source did not change are copied
   forward from the last snapshot.
4. If a page was added, removed, split, merged or renamed anywhere in the batch,
   `ui-progress lineage candidates --since <last snapshot sha>` lists those commits; add
   each edge to `.ui-progress/lineage.json` now, with the `sha` of the commit that did it,
   while you know exactly what happened and why.
5. If a filter, mode or other URL-driven state was added, add it to `screens.json`. If the
   change is worth a sentence in the Story, append a chapter to `changelog.json`.
6. `ui-progress build`.

## Lineage

Git cannot tell that a page was split in two. You can.

1. `ui-progress lineage candidates` lists every commit that changed the set of pages,
   with the evidence: files moved or copied between page folders, and other pages that
   shrank in the same commit.
2. For each commit, decide what happened. Read the commit message, and where the evidence
   is not conclusive, the diff (`git show <sha> --stat`, then the files that matter).
3. Write `.ui-progress/lineage.json`:

   ```json
   {
     "edges": [
       { "type": "split", "from": "/account", "to": ["/account/settings"], "sha": "ba0ada76",
         "date": "2026-09-17", "confidence": "high",
         "evidence": "New page is a 70% copy of /account, which lost 196 lines." }
     ],
     "reviewed": { "63c79488": "/changelog is a new feature" }
   }
   ```

   | type | meaning |
   | --- | --- |
   | `split` | one page became several; the original keeps part |
   | `extract` | a part of a page moved out to its own page |
   | `merge` / `absorb` | pages were folded into another |
   | `replace` | a page was superseded by a new one |
   | `rename` | same page, new address |
   | `clone` | a new page built from a copy of another (shared template, not shared content) |

   `from` and `to` take one route or a list. `evidence` is required: say what you saw, in
   one or two sentences. List every commit you judged to have **no** lineage under
   `reviewed`, with the reason, so the next pass does not redo it.
4. `ui-progress lineage check`, then `ui-progress build`.

`sha` is the commit that made the change, never the snapshot where you first noticed it:
snapshots get added later (between existing ones), and the viewer places each edge by its
commit. When `ui-progress lineage check` says an edge disagrees with the snapshots, look at
the commits it names (`git show <sha> --stat`). `ui-progress lineage check --fix` writes the
commit git found into `lineage.json` and keeps the old values under `corrected`; do that
when it agrees with the diff, and correct the edge by hand when it does not. Then
`ui-progress build`.

Be conservative: a copied boilerplate file is not lineage. Record `confidence` honestly.

## Story

After lineage, write the history as a short narrative the viewer shows as "Story":

1. `ui-progress build`, then `ui-progress changelog candidates`: per snapshot, what was
   added, removed, redesigned or merged, and the commit messages in between.
2. Write `.ui-progress/changelog.json`, one chapter per period that reads as one move
   (a redesign, a feature area arriving, a restructuring), not one per snapshot:

   ```json
   { "entries": [
     { "from": "2026-05-17", "to": "2026-05-23", "title": "The first collection browser",
       "text": "Two to four sentences: what appeared, what it looked like, what drove it.",
       "pages": ["/", "/items/[id]"], "snapshot": "832eb7ed" } ] }
   ```

   `pages` are routes to link; `snapshot` is the id of the snapshot that best shows the
   chapter. Write in plain language for the project's owner; name pages by what they do.
3. `ui-progress changelog check`, then `ui-progress build`.

## Check the result

Never report a capture as done without looking at it. Start with what the tool already
flagged: `suspects` in `snapshot.json` lists pages that were shot but look wrong (an error
overlay or framework error page, a hydration error, a sign-in form while signed in, a blank page, broken
images), and `skipped` lists pages that were not shot (`not found` includes pages that
rendered a not-found screen with status 200). Open those first, then a sample of the
others, in `.ui-progress/snapshots/<sha>/shots/`, and check:

- it is the page, not an error page, a blank page or a login form
- the data is there (lists are not empty, images are not broken)
- animations had finished (no half-faded content)
- the signed-out and signed-in versions differ where they should (`*.public.*` vs `*.user.*`)

Then read `snapshot.json`: `skipped` lists every route that was not captured and why.
Each entry is either fixed (seed more, add a `resolve` hint) or explained to the user.

## Committing `.ui-progress/`

When the user asks what to commit: `config.json`, `adapter.mjs` (and `adapter/`),
`plan.json`, `screens.json`, `lineage.json` and `changelog.json` always. They are what makes
the history reproducible. `snapshots/` and `viewer/` are ignored by default because every
snapshot is of a commit and can be rebuilt from git plus those files
(`ui-progress snapshot --plan`, then `ui-progress build`). Say this plainly. Committing the
screenshots too is fine when the user wants the history browsable without a rebuild: remove
the two lines from `.ui-progress/.gitignore`, and suggest Git LFS for `snapshots/**/*.png`.

## Findings

When **ui-progress itself** misbehaves, lacks something, or needs a workaround, record it
at once, before working around it:

```
ui-progress finding add --kind bug --title "Section detection misses accordion panels" \
  --detail "What happened, what was expected, how to reproduce, what you did instead." \
  --command "ui-progress snapshot abc1234" --sha abc1234 --log-file .ui-progress/snapshots/abc1234/run.log
```

Kinds: `bug`, `limitation`, `workaround`, `idea`. Failed snapshots add a `failure` finding
on their own; when the cause turns out to be the project's adapter and not the tool,
`ui-progress finding resolve <id>`.

At the end of the work, if there are open findings, run `ui-progress finding export` and
tell the user that `.ui-progress/findings/REPORT.md` is ready to send to the plugin's
maintainer. Findings can contain paths and log lines from their project: ask them to read
it before sending, and never send it anywhere yourself.

## Reference

- `${CLAUDE_PLUGIN_ROOT}/docs/ADAPTERS.md` — the adapter contract, with examples for Next.js, Django and others
- `${CLAUDE_PLUGIN_ROOT}/docs/CONFIGURATION.md` — every key of `config.json`
- `${CLAUDE_PLUGIN_ROOT}/docs/TROUBLESHOOTING.md` — common failures and their fixes
