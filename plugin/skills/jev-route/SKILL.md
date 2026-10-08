---
name: jev-route
description: Show which Opus 5.5 effort level (low/medium/high) the TypeSafe Jev reflex would pick for a task, and why, without running it. Use when the user asks how hard Jev thinks a task is or what effort it would use.
argument-hint: <task to classify>
allowed-tools: Bash
---

# Ask Jev for an effort decision

This makes one Jev call and no Claude call. It uses the locally installed `jev-opus` when there is one, otherwise the version pinned in this skill (never `@latest`):

```bash
jev() { if command -v jev-opus >/dev/null 2>&1; then jev-opus "$@"; else npx -y github:abby-inc/jev-opus#v0.5.0-abby.1 "$@"; fi; }
jev --route-only <<'JEV_TASK'
$ARGUMENTS
JEV_TASK
```

Report the task type, difficulty, stakes, the chosen effort, and the reasons line. If `$ARGUMENTS` is empty, ask the user which task to classify.

If Jev isn't configured, the answer comes from local heuristics. Tell the user that, and mention `jev-opus init`.
