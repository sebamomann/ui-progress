# Configuration

`.ui-progress/config.json`. Every key is optional; missing keys use the defaults shown.

## `sampling`: which commits

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"pilot"` | `pilot`, `monthly`, `weekly`, `daily`, `every-n`, `auto`, `all`, `manual` |
| `max` | `null` | Upper limit on snapshots. Pilot is always capped at 8 |
| `from`, `to` | `null` | Only commits in this date range (`YYYY-MM-DD`) |
| `branch` | `null` | Branch to follow; default is the checked-out one. Only its mainline (first-parent) commits are considered |
| `uiPaths` | `["."]` | Git pathspecs that count as UI code when measuring how much a commit changed. Narrow this (`["app", "src/components"]`) so backend work does not trigger snapshots |
| `everyN` | `25` | For `every-n` |
| `auto.churn` | `600` | In `auto`, take a snapshot once this many UI lines changed since the last one |
| `auto.minGapDays` | `1` | In `auto`, minimum days between two churn-triggered snapshots. Page additions and removals always trigger |

`ui-progress plan --mode X` overrides `mode` for that run and saves the result to
`plan.json`. `manual` leaves `plan.json` alone, so it can be edited freely.

## `capture`: what a snapshot contains

| Key | Default | Meaning |
| --- | --- | --- |
| `viewports` | desktop 1440×900, mobile 390×844 | Any number of named viewports. Each may carry `colorScheme: "light"` or `"dark"` (default: `capture.colorScheme`); the first viewport is the primary one, in whose scheme dialogs and sections are shot |
| `parallel` | `3` | Tabs capturing at the same time against one app instance |
| `signedOut` | `true` | Also capture each page without signing in, and keep it as a separate view where it differs |
| `states.enabled` | `true` | Click through each page to find sections, dialogs and menus |
| `states.maxClicks` | `20` | Controls tried per page |
| `states.maxPerPage` | `12` | Views kept per page |
| `states.depth` | `2` | `2` also tries tabs and buttons inside an opened dialog or menu |
| `states.depthClicks` | `3` | Controls tried inside each overlay |
| `states.budgetMs` | `45000` | Time limit for the click-through of one page |
| `states.totalBudgetMs` | `900000` | Time for the click-through over the whole snapshot (summed over tabs). After that, the remaining pages are shot without looking for their states; `screens.json` entries are still captured |
| `states.sectionChange` | `0.2` | Share of the page's text that must change for a click to count as a different section |
| `unsafe` | see below | Regex of button labels that are never clicked |
| `hide` | framework dev overlays | CSS selectors hidden before every screenshot |
| `checks.notFound` | 404 / "not found" in several languages | Regex on the title and main heading: a page that says it does not exist is skipped as `not found`, also when it answered 200 |
| `checks.errorSelectors`, `checks.errorTitle` | common dev-server overlays and framework error pages | A page that matches is shot but listed under `suspects` |
| `checks.hydration` | hydration mismatch messages (also React's minified codes) | Regex on uncaught page errors and console errors: a page whose render did not match the server's is shot but listed under `suspects` as `hydration error` |
| `checks.signInPaths` | login, register, auth, … | Routes where a password field is expected; elsewhere a sign-in form makes the page a suspect |
| `include`, `exclude` | `[]` | Regexes on routes; `exclude: ["^/admin"]` skips the admin area |
| `locale` | `"en-US"` | Browser locale |
| `colorScheme` | `"light"` | `light` or `dark`: what the browser reports as the preferred scheme |
| `maxPageHeight` | `9000` | Tallest full-page screenshot, in pixels |
| `settleRounds` | `20` | How long to wait for a page to stop animating, in 300 ms steps |
| `navTimeoutMs` | `45000` | Page load timeout |
| `crawlLimit` | `80` | Pages visited when the adapter has no route list |

`unsafe` defaults to destructive and state-changing words in English and German (delete,
remove, log out, save, send, confirm, accept, pay, …). Extend it for your language and
your app; a button that matches is never clicked, so its dialog is not captured either.

## `capture.incremental`: taking unchanged pages over

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Reuse the previous snapshot's screenshots for pages whose source did not change in between. Needs `routeOfFile` in the adapter; the import graph is followed from each page file (relative and tsconfig-alias imports), plus layout/template/loading/error files above it |
| `globalPaths` | package.json, `*.config.*`, global CSS, `public/**`, tailwind config | A change here recaptures everything |
| `translationPaths` | `messages/**`, `locales/**`, `i18n/**` | JSON message files; only pages that use a changed top-level key are affected |

Screenshots are stored once. A page taken over is not copied: its manifest entry is marked `copiedFrom` (the snapshot it is unchanged since) and `filesIn` (the snapshot whose `shots/` folder holds its files, always the one that rendered it). Browsing a snapshot still shows every page; the build resolves the references. A changed `viewports` setting disables reuse for that snapshot, since the pictures would not be comparable.

Capturing a snapshot again (`--force`) first moves the screenshots later snapshots use into the earliest of them, so the references stay valid.

## `run`: how snapshots are executed

| Key | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `3` | Snapshots built at the same time. Each one runs your app's dev server and a browser, roughly 2.5–3.5 GB together. The number is capped to what fits in memory (about one per 3.5 GB after reserving 6 GB; two on a 16 GB machine) unless you pass `--ignore-memory` |
| `basePort` | `4100` | First port; worker *n* uses `basePort + n` |
| `readyPath` | `"/"` | Path polled to know the app is up (the adapter's `start` can override it) |
| `readyTimeoutMs` | `180000` | How long to wait for it |
| `keepWorktrees` | `false` | Keep the checkout after a snapshot, for debugging |
| `workDir` | `~/.ui-progress/work/<repo>` | Where old commits are checked out. Keep it outside the repository |
| `fallback.enabled` | `true` | When a commit fails to install, seed, start or render, capture the next commit on the line instead (see below). `snapshot --no-fallback` turns it off for one run |
| `fallback.maxCommits` | `5` | Later commits tried, at most |
| `fallback.maxHours` | `24` | Only commits made within this many hours after the broken one |
| `fallback.errorPageShare` | `0.5` | A snapshot where more than this share of the rendered pages shows an error page or dev-server overlay counts as failed in `capture` |

### Commits that do not build

History has commits that never worked: a syntax error, a missing import, a page that
throws on every render, fixed minutes later. When a snapshot fails in `install`, `seed`,
`start` or `capture`, ui-progress tries the commits right after it, one at a time, within
`maxCommits` and `maxHours`. It never goes past a commit that is planned or captured
anyway. The first one that works is captured in its place: `plan.json` gets the stand-in
(its reason says which commit it stands in for), the broken commit goes into
`.ui-progress/unbuildable.json` with the phase and the cause, and its failure finding is
resolved, since the adapter evidently works.

If a stand-in fails the same way, the cause is the adapter or the machine, not the commit:
the fallback stops and nothing is recorded. Plans and snapshot runs skip every commit in
`unbuildable.json` from then on, also on other machines and in later sessions, so commit
the file. `ui-progress unbuildable` lists it; `unbuildable add <sha> --reason "..."` records
a commit by hand and `unbuildable remove <sha>` lets it be tried again (after the adapter
learned to build it, for example).

Hydration errors do not make a snapshot fail: the page usually renders. They are listed
under `suspects` in `snapshot.json` for review.

## `data`: whose data the snapshots use

| Key | Default | Meaning |
| --- | --- | --- |
| `isolation` | `"throwaway"` | Snapshots build their own dataset in a throwaway database. Before every seed command and before starting the app, ui-progress checks the environment, the env files and the config files of the checkout against the project's own databases and refuses if one matches. `"shared"` turns the check off; set it only if you want your real data in the history |
| `protect` | `[]` | Further connection strings to treat as the project's own |

The project's own databases are collected automatically: connection strings in the repository's `.env*` files (not `*.example`), in tracked files (scripts, compose files, old defaults), database names in container definitions (`POSTGRES_DB`, `MYSQL_DATABASE`, …), and database variables in your shell. A database on this machine is matched by name, whatever the port.

## `login`: sign-in without code

For a plain form, instead of an adapter `login` function:

```json
"login": { "url": "/login", "fill": { "input[name=email]": "test@example.com", "input[name=password]": "secret" }, "submit": "button[type=submit]" }
```

## `forward`: keeping the history current

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"auto"` | `auto`: when a Claude Code session changed UI files and is about to finish without a capture, a hook sends the agent back once to capture (or to say that nothing visible changed). `remind`: only a note at session start. `off`: nothing |

| `instructionsFile` | `null` | Whether you wanted the capture rule written into `AGENTS.md` / `CLAUDE.md`. Claude asks once during setup and records `true` or `false` here so it does not ask again |

The hooks come with the plugin and need no setup. For agents that do not load the plugin,
`ui-progress instructions --write` adds the same rule to `AGENTS.md` (or `CLAUDE.md`).

## `lineage`

| Key | Default | Meaning |
| --- | --- | --- |
| `pagePaths` | `["."]` | Git pathspecs searched for page files. Narrow to the folder that holds routes |

## `thresholds`

| Key | Default | Meaning |
| --- | --- | --- |
| `redesign` | `0.3` | Share of the page (0–1) that must look different for a view to be labelled "redesign" |
| `tweak` | `0.02` | Share from which it is labelled "tweak". Below this the view counts as unchanged and the viewer hides that snapshot for it |

The screenshot is cut into small blocks and the changed blocks are counted, so a different
date or counter does not register while a moved layout does. Identical files are always
unchanged. Different seed data between two snapshots still counts as change.
