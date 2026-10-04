# .ui-progress

This folder is managed by the [ui-progress](https://github.com/sebamomann/ui-progress) plugin.
It records how this project's UI changed over time.

| Path | What it is | Commit it? |
| --- | --- | --- |
| `config.json` | Sampling mode, viewports, capture limits | yes |
| `adapter.mjs` | How to install, seed, start and sign in to this app at any commit | yes |
| `NOTES.md` | What every agent working on this history must know and respect: the user's wishes and caveats found so far | yes |
| `plan.json` | The commits chosen for a snapshot | yes |
| `lineage.json` | Page splits, merges and renames, with the evidence for each | yes |
| `runs.jsonl` | Every snapshot attempt and batch: timings, outcome, adapter changes, agent cost | yes |
| `findings/` | Problems with ui-progress itself, to send to its maintainer | optional |
| `snapshots/` | A manifest per commit, every screenshot once in `snapshots/_store/`; rebuildable (see below) | ignored by default |
| `viewer/` | The viewer and its derived data. Open `viewer/index.html` | ignored by default |
| `work/` | Throwaway checkouts | never |

Every snapshot is of a commit, built in a throwaway checkout with generated data, so the
screenshots can be rebuilt at any time from git and the committed files above
(`ui-progress snapshot --plan`). Committing them is a choice for convenience (the history is
browsable without rebuilding), not a requirement; Git LFS keeps the repository small if you
do.

Common commands (run from the repository root):

```
ui-progress status          # what is planned, done, failed
ui-progress pending         # is HEAD captured? (capture once after a batch of commits)
ui-progress snapshot --plan # capture what is still missing
ui-progress view            # rebuild and open the viewer
```
