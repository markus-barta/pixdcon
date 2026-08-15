# AGENTS.MD

Markus owns this. Start: say hi + 1 motivating line.
Work style: telegraph; noun-phrases ok; minimal grammar; min tokens.

> **This is the pixdcon delta only.** Universal INSPR rules (secret handling,
> git safety, cross-repo authoring, trust contexts) live in the kernel, vendored
> as the `./doctrine` submodule and auto-loaded by `CLAUDE.md`. Domain depth
> loads on demand: `/ppm` `/dev` `/secrets` `/ops` `/nix` `/iac` `/style`
> `/incident`; `/inspr` prints the map. Repo-local commands: `/deploy`,
> `/pixdcon-dev`, `/pixdcon-push`.
>
> Bump the doctrine with `git submodule update --remote doctrine`.

## Response Style

**TL;DR placement rules:**

- Long answers: TL;DR at beginning AND end
- Short answers: TL;DR only at end
- Very short answers: no TL;DR needed
- Use this syntax for TL;DR: "📍 TL;DR: <summary>"

## Agent Protocol

- Contact: Markus Barta (@markus-barta, markus@barta.com).
- Devices: `imac0` (home iMac), `mba-imac-work` (work iMac), `mba-mbp-work` (portable MacBook).
- PRs: use `gh pr view/diff` (no URLs).
- Only edit AGENTS when user says "edit AGENTS.md"
- Guardrails: use `trash` for deletes, never `rm -rf`.
- Web: search early; quote exact errors; prefer 2026+ sources, fallback to 2025+, then older results.
- Style: Friendly telegraph. Drop filler/grammar. Min tokens.

## Screenshots ("use a screenshot")

- Pick newest PNG in `~/Desktop` or `~/Downloads`.
- Verify it's the right UI (ignore filename).
- Size check: `sips -g pixelWidth -g pixelHeight <file>`.
- Optimize tool: for macOS `imageoptim <file>` on Linux `image_optim <file>` - STOP and tell user if the tool is missing.

## Important Locations

| What                  | Location/Notes                                                    |
| --------------------- | ----------------------------------------------------------------- |
| Secrets / credentials | 1Password (no agent access) — ping Markus for creds               |
| Task/project mgmt     | Paimos at `pm.barta.cm` — pixdcon = project `PIXD` (id 13)        |
| Knowledge base        | Paimos Knowledge on `PIXD` — durable docs live there, not in repo |

### Task Tracking — Paimos

All tasks and durable knowledge live in **Paimos** (`pm.barta.cm`, instance `ppm`).
No repo backlog files.

**Use the `paimos` CLI. Run `/ppm` first** — it loads the domain pack with auth,
conventions, statuses and the project landscape.

```bash
paimos auth whoami                                   # canonical auth smoke
paimos issue list --project PIXD
paimos issue update PIXD-30 --status in-progress
paimos knowledge list --project PIXD
paimos knowledge update runbook deploy-to-hsb1 --project PIXD --body-file <file>
```

🔴 **Two auth surfaces — do not conflate them.** The `paimos` CLI reads the OS
keyring and is the privileged path. `~/.inspr/secrets/agents/PPMAPIKEY.env` is a
_separate, weaker_ credential for raw `curl`, and **sourcing it does not
authenticate the CLI**. Learned the hard way (PIXD-44): the raw-curl key returns
`403` on Knowledge writes, which reads like "not permitted" rather than "wrong
credential". If a write 403s, try the CLI before concluding you lack access.

Prefer `--body-file` / `--description-file` / `--ac-file` for multiline fields —
they avoid the shell-quoted-JSON foot-gun.

- **Types**: `task`, `ticket` (bug)
- **Priorities**: `low`, `medium`, `high`
- **Statuses**: `backlog`, `new`, `in-progress`, `qa`, `delivered`, `done`, `accepted`, `cancelled`
- Reference issue keys in commit subjects (e.g., `feat(telemetry): … (PIXD-26)`)
- Knowledge entries are typed: `runbook`, `guideline`, `memory`, `external-system`,
  `related-project`. Addressed as `<type> <slug>`, not by numeric id.

## Docs

- Follow links until domain makes sense; honor existing patterns.
- Keep notes short; update docs when behavior/API changes (no ship w/o docs).

## Markdown Policy

- **NEVER** create new `.md` files unless user explicitly requests ("create a new doc for X").
- Prefer editing existing docs over creating new ones.
- When asked to "document X": update README.md or existing file, don't create new.
- If tempted to create: ask first ("Should I add this to README.md or create new file?").

## Command Timestamps

- Prefix potentially long-running commands (>10s) with `date &&` (bash) or `date; and` (fish).
- Applies to: searches, nix builds, docker ops, large file ops, test suites, package installs.
- When in doubt, add timestamp. Better unnecessary than wondering when it started.

## Build / Test

- Before handoff: run full gate (lint/typecheck/tests/docs).
- CI red: `gh run list/view`, rerun, fix, push, repeat til green.
- Keep it observable (logs, panes, tails).
- Release: read `docs/BUILD-DEPLOY.md` or relevant checklist.

## Git

- Safe by default: `git status/diff/log`. Push only when user asks.
- `git checkout` ok for PR review / explicit request.
- Branch changes require user consent.
- Destructive ops forbidden unless explicit (`reset --hard`, `clean`, `restore`, `rm`, …).
- Don't delete/rename unexpected stuff; stop + ask.
- No repo-wide S/R scripts; keep edits small/reviewable.
- No amend unless asked.
- Big review: `git --no-pager diff --color=never`.

## Git Security

**NEVER commit secrets.** Forbidden:

- Plain text passwords, API keys, tokens, bcrypt hashes
- Any `.env` files with real credentials

**Safe to commit:** `.env.example` with placeholders, code referencing env vars.

**Before every commit:** `git diff` to scan for secrets; `git status` to verify files.

**If secrets committed:** STOP AND IMMEDIATELY TELL USER, then discuss → rotate credential → if pushed, assume compromised.

**AI responsibility:** Detect potential secret → STOP → alert user → suggest env var → wait for confirmation.

## Encrypted Files

**NEVER touch `.age`/`.gpg`/`.enc` files without explicit permission.**

## Language/Stack Notes

### Shell (Fish/Bash)

- User runs fish shell on all machines.
- Shebang: prefer `#!/usr/bin/env bash` for scripts.
- Use shellcheck patterns.

## Critical Thinking

- **Clarity over speed**: If uncertain, ask before proceeding. Better one question than three bugs.
- Fix root cause (not band-aid).
- Unsure: read more code; if still stuck, ask w/ short options.
- Conflicts: call out; pick safer path.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
- Leave breadcrumb notes in thread.

## Tools

### trash

- Move files to Trash: `trash <file>` (never use `rm -rf`).

### gh

- GitHub CLI for PRs/CI/releases.
- Examples: `gh issue view <url>`, `gh pr view <url> --comments --files`.

<frontend_aesthetics>
Avoid "AI slop" UI. Be opinionated + distinctive.

Do:

- Typography: pick a real font; avoid Inter/Roboto/Arial/system defaults.
- Theme: commit to a palette; use CSS vars; bold accents > timid gradients.
- Motion: 1–2 high-impact moments (staggered reveal beats random micro-animation).
- Background: add depth (gradients/patterns), not flat default.

Avoid: purple-on-white clichés, generic component grids, predictable layouts.
</frontend_aesthetics>
