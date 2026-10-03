# .ui-progress

This folder is managed by the [ui-progress](https://github.com/sebamomann/ui-progress) plugin.
It records how this project's UI changed over time.

| Path | What it is | Commit it? |
| --- | --- | --- |
| `config.json` | Sampling mode, viewports, capture limits | yes |
| `adapter.mjs` | How to install, seed, start and sign in to this app at any commit | yes |
| `plan.json` | The commits chosen for a snapshot | yes |
| `lineage.json` | Page splits, merges and renames, with the evidence for each | yes |
| `findings/` | Problems with ui-progress itself, to send to its maintainer | optional |
| `snapshots/` | Screenshots and manifests, one folder per commit | ignored by default |
| `viewer/` | The viewer and its derived data. Open `viewer/index.html` | ignored by default |
| `work/` | Throwaway checkouts | never |

Common commands (run from the repository root):

```
ui-progress status          # what is planned, done, failed
ui-progress pending         # is HEAD captured? (capture once after a batch of commits)
ui-progress snapshot --plan # capture what is still missing
ui-progress view            # rebuild and open the viewer
```
