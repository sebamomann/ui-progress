# Working on ui-progress

ui-progress is a Claude Code plugin that records how a web app's UI evolved across its git
history. These rules are for anyone (human or agent) changing the plugin itself.

## Commit in small, focused steps

Commit after every self-contained change, not once at the end of a session.

- One concern per commit: a bug fix, a new option, a doc update that belongs to it. Do not
  mix an unrelated refactor into a feature commit.
- Each commit should leave the repository working: `node --check` passes for every changed
  module and `node bin/ui-progress help` still runs.
- Commit only the files of that step (`git commit -- <paths>`); leave files you did not
  write, or that someone else staged, alone.
- The subject line says what changed for the user of the plugin; the body lists the
  details and the reason.

The history is how we know what changed when and why. That matters twice over here: the
plugin itself reads a project's history commit by commit, and it only works well on
repositories whose commits are small and meaningful.

## Stay agnostic

The plugin must work for any web stack (Next.js, Django, Rails, Laravel, Vite SPAs, static
sites, ...) and any kind of application. Nothing in `core/`, `viewer/`, `skills/`,
`templates/` or `docs/` may assume one framework, database, language, domain or project.
Examples use neutral subjects (items, listings, settings), and anything stack-specific
belongs in an adapter, a template preset or a clearly labelled example.

## Snapshots are of commits only

Every snapshot is a commit, checked out into a throwaway worktree and run with a throwaway
database. Do not add ways to capture a running app, a working tree or the user's own data.

## Releasing

Bump the version in `core/util.mjs` (`VERSION`) and `.claude-plugin/plugin.json` together,
in a commit of its own. When a release adds a `ctx` method, add it with its version to
`CTX_METHODS` in `core/config.mjs`, so adapters that use it fail early on older installs.
