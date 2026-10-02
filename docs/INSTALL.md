# Install

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 18 or newer, and git
- About 500 MB of disk for the browser the screenshots are taken with
- Whatever the tracked project itself needs to run locally (its package manager, its database server)

## 1. Add the plugin

From a GitHub repository:

```
claude plugin marketplace add sebamomann/ui-progress
claude plugin install ui-progress@ui-progress
```

From a folder on your machine (a clone, or an unpacked zip):

```
claude plugin marketplace add /path/to/ui-progress
claude plugin install ui-progress@ui-progress
```

To try it for one session without installing: `claude --plugin-dir /path/to/ui-progress`.

Restart Claude Code, or run `/reload-plugins` in a running session.

## 2. Install the screenshot dependencies

Once per machine. In a terminal, or by asking Claude to do it:

```
ui-progress doctor --install
```

This installs Playwright, a Chromium build and the sharp image library into
`~/.ui-progress/deps`. Nothing is added to your project. `ui-progress doctor` on its own
shows what is present.

If `ui-progress` is not found in your own terminal, that is expected: the command is on
PATH inside Claude Code sessions only. Outside, call it by its full path:
`node /path/to/ui-progress/bin/ui-progress`.

## 3. Set up a project

Open Claude Code in the repository you want to track and say:

> Set up ui-progress for this project and run a pilot.

Continue with [SETUP.md](SETUP.md).

## Update

Claude Code does not announce new plugin versions. Either turn on automatic updates once,
or update by hand:

- **Automatic:** in a session, `/plugin`, open **Marketplaces**, select `ui-progress`, and
  choose **Enable auto-update**. New versions are then fetched in the background after a
  session starts.
- **By hand:**

  ```
  claude plugin marketplace update ui-progress
  claude plugin update ui-progress@ui-progress
  ```

Then, in each tracked repository, `ui-progress view` (or `build`). The viewer in
`.ui-progress/viewer/` is a copy made at build time, so a new plugin version reaches it
only when the viewer is rebuilt; the screenshots and data stay as they are. After an
update, the first session in a tracked repository says that the viewer is out of date, and
Claude rebuilds it when asked.

## Uninstall

```
claude plugin uninstall ui-progress@ui-progress
rm -rf ~/.ui-progress          # browser, image library and old checkouts
```

The `.ui-progress/` folder in each tracked repository is yours; delete it if you no longer want the history.
