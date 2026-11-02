# {{name}}

{{description}}

## The rule for changing live systems

**The owner makes changes by hand.** Inspecting is fine at any time: read-only commands, status, logs. For anything that changes state, present the exact commands and let the owner run them.

<!-- If some actions are pre-approved (a wrapper script, a skill), list them here and nothing else. -->

## Read first

- `.project/tasklist.md`: where the work stands and what is next. Private (gitignored). Update it at the end of each session.
- `docs/DECISIONS.md`: why things are the way they are.
- `docs/systems.md`: what exists, addresses, how to reach it.
- `docs/runbook.md`: how to do the common things, and how to undo them.

## Layout

- `docs/`: the notes above
- `bin/`: helper scripts. Keep secrets out of them; credentials live in the password manager.

## Rules

- Never write passwords, tokens or keys into this repo. Use placeholders such as `__PASSWORD__` and say where the real one lives.
- If something observed on the live system contradicts these docs, update the doc and note the date rather than trusting the old text.

## Before finishing a change

Say what was checked against the live system and what was only written down.
