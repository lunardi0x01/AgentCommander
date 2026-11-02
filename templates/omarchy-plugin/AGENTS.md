# {{name}}

{{description}}

An Omarchy/Quickshell plugin. Plugin id: `{{user}}.{{id}}` (permanent once published).

## Read first

- `.project/tasklist.md`: where the work stands and what is next. Private (gitignored). Update it at the end of each session.
- `docs/DECISIONS.md`: why things are the way they are.
- `.claude/rules/`: file naming, the security checklist and where private notes live. Apply them from the first commit.

## Commands

- Validate the manifest: `omarchy plugin validate .`
- QML syntax check: `/usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell bar_widget.qml`. Expect a lot of "not found" noise for `qs.*` imports; look for real `error` or syntax lines.
- QML loads once at shell start, so reload after changes: `omarchy-restart-shell`.
- Try it from git: `omarchy plugin add <git-url> --enable`, then `omarchy plugin update {{user}}.{{id}}`.

## Rules

- File names are lowercase `snake_case`; docs and `LICENSE` keep their conventional names.
- Credentials never reach QML. Keep them in a helper script and a `0600` file.
- `entryPoints` in `manifest.json` must match the file names and case exactly.
- No symlinks anywhere in the repo.

## Before finishing a change

`omarchy plugin validate .`, the QML syntax check, then reload the shell and try it. Say what could not be checked from here.
