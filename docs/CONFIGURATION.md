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
| `viewports` | desktop 1440×900, mobile 390×844 | Any number of named viewports. The first is the primary one |
| `signedOut` | `true` | Also capture each page without signing in, and keep it as a separate view where it differs |
| `states.enabled` | `true` | Click through each page to find sections, dialogs and menus |
| `states.maxClicks` | `14` | Controls tried per page |
| `states.maxPerPage` | `10` | Views kept per page |
| `states.sectionChange` | `0.2` | Share of the page's text that must change for a click to count as a different section |
| `unsafe` | see below | Regex of button labels that are never clicked |
| `hide` | framework dev overlays | CSS selectors hidden before every screenshot |
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

## `run`: how snapshots are executed

| Key | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `3` | Snapshots built at the same time. Each one runs your app, so lower it on a small machine |
| `basePort` | `4100` | First port; worker *n* uses `basePort + n` |
| `readyPath` | `"/"` | Path polled to know the app is up (the adapter's `start` can override it) |
| `readyTimeoutMs` | `180000` | How long to wait for it |
| `keepWorktrees` | `false` | Keep the checkout after a snapshot, for debugging |
| `workDir` | `~/.ui-progress/work/<repo>` | Where old commits are checked out. Keep it outside the repository |

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
