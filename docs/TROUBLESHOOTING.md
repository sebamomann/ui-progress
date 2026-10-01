# Troubleshooting

Each snapshot keeps its logs in `.ui-progress/snapshots/<sha>/`: `run.log` (every command
of the adapter and the capture), `server.log` (the app's output), `FAILED` (the phase and
message). Set `UI_PROGRESS_DEBUG=1` for stack traces from the CLI itself.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing dependency "playwright"` | Screenshot dependencies not installed | `ui-progress doctor --install` |
| `ui-progress: command not found` in your own terminal | The command is on PATH only inside Claude Code | `node /path/to/plugin/bin/ui-progress …` |
| Snapshot fails in `install` | Old commit needs another Node or package manager version, or has no lockfile | Branch in `install` on `ctx.has(...)`; use `npm install` when there is no lockfile; use a version manager in the command (`fnm exec --using 18 -- npm ci`) |
| Snapshot fails in `seed` with a migration error | Old migrations only applied on top of data the real database had | Build the schema directly from the schema file for that era (Prisma: `db push`; Django: `migrate --run-syncdb`) |
| `migrations did not reach …: it has no tables` | The commit hardcodes a database URL, so the migration went elsewhere | Rewrite the literal URL in the checkout before migrating. Check your real database was not changed |
| Snapshot fails in `start`: "did not answer" | Wrong port or `readyPath`, or the app crashed | Read `server.log`. Make sure the command uses `ctx.port`. Raise `run.readyTimeoutMs` for slow first compiles |
| "… pages answered with a server error" | The app runs but every page throws | `server.log` shows the first error. Often a missing env variable the old commit needed, or files resolved from the wrong folder |
| Pages are blank or show the app's error boundary | Seed data in a shape that commit cannot render (for example image URLs stored differently in that era) | Look at `server.log`, adjust the seed for that era |
| The app picks up config or modules from the live repository | Checkouts were placed inside the repository | Leave `run.workDir` unset (default is `~/.ui-progress/work`) |
| Only public pages captured, `loginError` in `manifest.json` | Sign-in failed | Run with `run.keepWorktrees: true`, start the app by hand, fix `login` |
| A dynamic route is `unresolved` | Nothing links to it and `resolve` has no URL for it | Seed a record for it and return its URL from `resolve` |
| A page is captured empty | Its feature is not seeded | Seed it. An empty state is a gap, not a result |
| Screenshot taken mid-animation | Animation longer than the wait, or looping | Raise `capture.settleRounds`; looping animations cannot settle, hide them with `capture.hide` |
| Sticky header or floating button in the middle of a tall screenshot | The element is positioned by script, not CSS | Add its selector to `capture.hide` |
| A dialog is missing | Its button's label matches `capture.unsafe`, or the click budget ran out | Narrow `unsafe`, raise `states.maxClicks` |
| A screenshot shows the result of an action (item marked done, offer accepted) | An action button was clicked while looking for sections | Add its label to `capture.unsafe` |
| The same dialog appears as separate rows across time | Views are matched by their button label, and the label changed | Known limitation; record a finding if it matters to you |
| Capture is slow | Section and dialog discovery reloads the page after every click that changed it | Lower `states.maxClicks`, set `states.enabled: false` for a quick pass, raise `run.concurrency` |
| Everything is "redesign" | Different seed data between eras counts as visual change | Raise `thresholds.redesign`; keep the seed stable across eras where possible |
| Disk fills up | Kept checkouts or many snapshots | `rm -rf ~/.ui-progress/work`; snapshots are 20–40 MB each |

## Starting over

```
rm -rf .ui-progress/snapshots .ui-progress/viewer    # keep config, adapter, plan, lineage
ui-progress snapshot --plan
```

## Reporting a bug in ui-progress

```
ui-progress finding add --kind bug --title "…" --detail "…" --log-file .ui-progress/snapshots/<sha>/run.log
ui-progress finding export
```

and send `.ui-progress/findings/REPORT.md` after reading it.
