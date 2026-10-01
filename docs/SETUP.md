# Set up and use

Everything below can be done by asking Claude in plain words; the commands are shown so you
know what happens and can run them yourself.

## The idea

1. **Adapter.** Claude reads your project and writes `.ui-progress/adapter.mjs`: how to
   install it, create and seed a throwaway database, start it and sign in, at any commit.
2. **Plan.** You choose how densely to sample the history.
3. **Snapshots.** Each chosen commit is checked out into a temporary folder, started, and
   every page is screenshotted on desktop and mobile: signed out and signed in, plus every
   section, dialog and menu one click away.
4. **Lineage.** Claude reads the commits that changed the set of pages and records what
   was split, merged, replaced or renamed, with its evidence.
5. **Viewer.** A static page in `.ui-progress/viewer/` shows it all.

## First run: a pilot

> Set up ui-progress for this project and run a pilot.

Claude will ask at most a couple of questions (for example whether it may create throwaway
databases on your local database server), write the adapter, test it on three commits, and
then capture about one commit per month. A pilot takes minutes, not hours, and shows you
what the full history would look like.

```
ui-progress init --preset next-app     # or next-pages, crawl, blank
ui-progress plan --mode pilot
ui-progress snapshot --plan
ui-progress view
```

## Going denser

Pick a mode; only the commits that are not captured yet are run.

| You say | Mode | What is captured |
| --- | --- | --- |
| "one per month" | `monthly` | the last commit of each month |
| "one per week" | `weekly` | the last commit of each week |
| "one per day" | `daily` | the last commit of each day with commits |
| "every 25 commits" | `every-n` | set `sampling.everyN` |
| "you decide" | `auto` | commits that added or removed a page, or where a lot of UI code changed since the last pick; Claude can then adjust the list by hand |
| "everything" | `all` | every commit (small repositories only) |
| "exactly these" | `manual` | the commits listed in `.ui-progress/plan.json` |

```
ui-progress plan --mode weekly --max 40          # preview and save
ui-progress plan --mode auto --from 2026-06-01   # only part of the history
ui-progress plan --mode auto --print             # preview without saving
ui-progress snapshot --plan --concurrency 4
ui-progress status
```

`--max` thins the plan evenly (or, in auto mode, keeps the commits that changed most).
See [CONFIGURATION.md](CONFIGURATION.md) for every option, including viewports, which
buttons are never clicked, and routes to include or exclude.

## Keeping it up to date

Nothing to configure. With the plugin enabled, two hooks run in every tracked repository:

- **At session start** Claude is told the repository records its UI history.
- **When Claude is about to finish** and UI files changed during the session without a
  capture, it is sent back once: capture, or state that nothing visible changed.

So after a UI change Claude captures the new state on its own:

```
ui-progress snapshot HEAD                          # clean build of the commit
ui-progress snapshot --live http://localhost:3000  # the dev server you already have running
ui-progress build
```

Set `"forward": { "mode": "remind" }` (note only) or `"off"` in `config.json` to tone this
down. Agents that do not load the plugin (another tool, a teammate without it) can get the
same rule from the project's instructions file. Claude asks about this once during setup,
explains why, and writes it for you on a yes; the command behind it is:

```
ui-progress instructions --write     # adds a marked section to AGENTS.md or CLAUDE.md
```

`--live` shows your development data and takes page screenshots only. Dialogs and
sections are found by clicking, which it will not do in your own data unless you add
`--states`.

You can also just ask: "capture the current UI".

## Looking at it

```
ui-progress view
```

opens `.ui-progress/viewer/index.html`. It is a plain file; no server is needed.

- **Graph**: one line per page over real time. Lines curve out of the page they came from
  and into the page they were folded into. No screenshots, just structure. Hover a curve
  to read the evidence.
- **Screens over time**: one row per page, one column per snapshot, as thumbnails. Open a
  row to see its sections, dialogs and menus.
- **Snapshots**: the whole site at one commit, with what was added, redesigned, removed.
- **Unchanged snapshots are hidden**: a view only shows the snapshots where it first
  existed or changed. Tick "Show unchanged" to see every snapshot.
- **A page**: pick any of its views on the left (whole page, signed out, each section,
  each dialog) and see that view across time, with a before/after slider.

Click any screenshot to enlarge it, then use the arrow keys to step through time.

## What to commit

`.ui-progress/.gitignore` ignores the screenshots and the viewer by default, because they
are large. `config.json`, `adapter.mjs`, `plan.json` and `lineage.json` are small and
worth committing: with them, anyone can regenerate the history. Remove the lines from that
`.gitignore` if you want the screenshots in the repository too.

## Reporting problems with the plugin

Claude records problems with ui-progress itself as it meets them, in
`.ui-progress/findings/`. To send them to the maintainer:

```
ui-progress finding list
ui-progress finding export     # writes .ui-progress/findings/REPORT.md
```

Read `REPORT.md` first (it can contain paths and log lines from your project), then attach
it to an issue or an email. Nothing is sent automatically.
