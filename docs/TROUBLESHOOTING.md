# Troubleshooting

Each snapshot keeps its logs in `.ui-progress/snapshots/<sha>/`: `run.log` (every command
of the adapter and the capture), `server.log` (the app's output), `FAILED` (the phase and
message). Set `UI_PROGRESS_DEBUG=1` for stack traces from the CLI itself.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing dependency "playwright"` | Screenshot dependencies not installed | `ui-progress doctor --install` |
| `ui-progress: command not found` in your own terminal | The command is on PATH only inside Claude Code | `node /path/to/plugin/bin/ui-progress …` |
| Snapshot fails in `install` | Old commit needs another Node or package manager version, or has no lockfile | Branch in `install` on `ctx.has(...)`; use `npm install` when there is no lockfile; use a version manager in the command (`fnm exec --using 18 -- npm ci`) |
| A planned commit was replaced by a later one ("stands in for …") | The commit does not build or run, and a commit right after it does | Nothing to do: it is recorded in `unbuildable.json` and skipped from now on. If the adapter was at fault after all, fix it and run `ui-progress unbuildable remove <sha>` |
| `… failed the same way: probably not the commit's fault` | The commit after the failing one fails with the same error, so the fallback stopped | Fix the adapter from `run.log` and `server.log`, then rerun the snapshot |
| Snapshot fails in `capture`: "pages show an error page or overlay" | Most pages rendered an error page or dev-server overlay | Usually a broken commit, handled by the fallback. If every commit does it, open a shot: a missing env var or service the adapter must provide |
| Snapshot fails in `seed` with a migration error | Old migrations only applied on top of data the real database had | Build the schema directly from the schema file for that era (Prisma: `db push`; Django: `migrate --run-syncdb`) |
| `migrations did not reach …: it has no tables` | The commit hardcodes a database URL, so the migration went elsewhere | Call `ctx.rewriteDatabaseUrls(throwawayUrl)` in `seed` before migrating. Check your real database was not changed |
| `Another ui-progress run is working on this repository` | A second run (another session, or another installed version) started while one is going | Wait for it, or stop the named process. If it is gone, delete `.ui-progress/.lock` |
| `port … is in use; using …` in `run.log` | Another app listens on `run.basePort + slot` | Nothing to do; set `run.basePort` elsewhere to avoid the shift |
| `the app exited right after start, and something else answered` | The app could not bind its port | Make sure the start command uses `ctx.port` |
| Snapshot fails in `start`: "did not answer" | Wrong port or `readyPath`, or the app crashed | Read `server.log`. Make sure the command uses `ctx.port`. Raise `run.readyTimeoutMs` for slow first compiles |
| "… pages answered with a server error" | The app runs but every page throws | `server.log` shows the first error. Often a missing env variable the old commit needed, or files resolved from the wrong folder |
| Pages are blank or show the app's error boundary | Seed data in a shape that commit cannot render (for example image URLs stored differently in that era) | Look at `server.log`, adjust the seed for that era |
| The app picks up config or modules from the live repository | Checkouts were placed inside the repository | Leave `run.workDir` unset (default is `~/.ui-progress/work`) |
| Only public pages captured, `loginError` in `manifest.json` | Sign-in failed | Run with `run.keepWorktrees: true`, start the app by hand, fix `login` |
| A dynamic route is `unresolved` | Nothing links to it and `resolve` has no URL for it | Seed a record for it and return its URL from `resolve` |
| A page is captured empty | Its feature is not seeded | Seed it. An empty state is a gap, not a result |
| Screenshot taken mid-animation | Animation longer than the wait, or looping | Raise `capture.settleRounds`; looping animations cannot settle, hide them with `capture.hide` |
| A form, list or panel that fades in is missing from the screenshot | It appears after a pause longer than `capture.settleQuietMs`, or only through an animation reduced motion turns off | Raise `capture.settleQuietMs`, name it in `capture.waitFor`, or set `capture.reducedMotion: false` if it never shows |
| Sticky header or floating button in the middle of a tall screenshot | The element is positioned by script, not CSS | Add its selector to `capture.hide` |
| A dialog is missing | Its button's label matches `capture.unsafe`, or the click budget ran out | Narrow `unsafe`, raise `states.maxClicks` |
| A screenshot shows the result of an action (item marked done, offer accepted) | An action button was clicked while looking for sections | Add its label to `capture.unsafe` |
| A sidebar, banner or tab is open on some pages and closed on others | The app saves the choice in a cookie or storage, and sign-in itself set it | Every page starts from the cookies and storage that sign-in left, so set the state you want shot in `login` (or seed it). Names that look like credentials (session, token, auth, csrf, sid) keep their latest value instead |
| The same dialog appears as separate rows across time | Views are matched by their button label, and the label changed | Known limitation; record a finding if it matters to you |
| Capture is slow | Section and dialog discovery reloads the page after every click that changed it | Lower `states.maxClicks`, set `states.enabled: false` for a quick pass, raise `run.concurrency` |
| Everything is "redesign" | Different seed data between eras counts as visual change | Raise `thresholds.redesign`; keep the seed stable across eras where possible |
| A long run is killed, or the machine becomes unresponsive | Too many snapshots in parallel for the memory available | Lower `run.concurrency`. The automatic cap assumes 3.5 GB per snapshot; large apps need more |
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
