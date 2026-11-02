# {{name}}

{{description}}

A World of Warcraft addon. The addon folder is `{{pascal}}/`; the rest of the repo is tooling.

## Read first

- `.project/tasklist.md`: where the work stands and what is next. Private (gitignored). Update it at the end of each session.
- `docs/DECISIONS.md`: why things are the way they are.

## Commands

- Install into the game: `./install.sh [path/to/Interface/AddOns]` (or set `WOW_ADDONS_DIR`).
- In game: `/reload` after changes. A brand new addon folder needs a full restart of the game.

## Rules

- The `## Interface:` number in `{{pascal}}/{{pascal}}.toc` must match the game build; get it in game with `/dump (select(4, GetBuildInfo()))`.
- Every file the addon loads must be listed in the `.toc`.
- Check the current API in the game's own docs or wiki before using a function; it changes between patches.

## Before finishing a change

Install, `/reload`, and watch for Lua errors. Say what could not be tried here: the game is not running from this shell.
