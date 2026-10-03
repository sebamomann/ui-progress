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

So after committed UI changes Claude captures the new state on its own, once at the end
of the task rather than after every commit:

```
ui-progress pending                   # is HEAD captured? which commits would it cover?
ui-progress snapshot HEAD             # one snapshot for the whole batch of commits
ui-progress build
```

Every snapshot is of a commit. Uncommitted changes are not captured; Claude tells you a
capture is due once you commit. Small, focused commits make the history (and the lineage
recorded for it) much more useful.

Snapshots never use your development, test or production databases, and never photograph
an app you are running: each checks out the commit, builds its own data in a throwaway
database, and ui-progress refuses to run if a command would reach one of the project's own
databases.

Set `"forward": { "mode": "remind" }` (note only) or `"off"` in `config.json` to tone this
down. Agents that do not load the plugin (another tool, a teammate without it) can get the
same rule from the project's instructions file. Claude asks about this once during setup,
explains why, and writes it for you on a yes; the command behind it is:

```
ui-progress instructions --write     # adds a marked section to AGENTS.md or CLAUDE.md
```

Pages whose source did not change since the last snapshot are copied forward rather than
re-shot, so a capture after a small change takes seconds, not minutes.

You can also just ask: "capture the current UI".

## Hand-picked screens and the story

Two more files in `.ui-progress/` that Claude writes for you:

- `screens.json`: views the automatic click-through cannot reach on its own, such as a
  filter that lives in the URL (`/?status=inactive`) or a search result. Claude reads the
  code for such states during setup and adds them; each entry is a route, a label, and a URL
  or a few steps (click, fill, hover).
- `changelog.json`: the history as a few written chapters, shown in the viewer as "Story".
  Claude writes it from the lineage and the captured changes (`ui-progress changelog
  candidates` gives it the material).

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
- **Story**: the written chapters, each linking its pages and the snapshot that shows it.
- **Highlight changes** (sidebar) tints the parts of a screenshot that differ from the
  previous snapshot, in the enlarged view and in the compare slider.
- **Play** (on a page, or in the enlarged view) steps through time automatically.
- Under each screenshot in a page's strip, "N source files changed" lists the files behind
  that change.
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
