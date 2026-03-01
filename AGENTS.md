# AGENTS.MD

Markus owns this. Start: say hi + 1 motivating line.
Work style: telegraph; noun-phrases ok; minimal grammar; min tokens.

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

## Important Locations

| What                  | Location/Notes                                      |
| --------------------- | --------------------------------------------------- |
| Secrets / credentials | 1Password (no agent access) — ping Markus for creds |
| Task/project mgmt     | `+pm/` per repo                                     |

### Creating +pm Backlog Items

**ALWAYS use scripts** for backlog items. Never manual file creation.

```bash
# From repo root
./scripts/create-backlog-item.sh [priority] [description]

# Examples
./scripts/create-backlog-item.sh A10 implement-critical-fix
./scripts/create-backlog-item.sh P50 refactor-auth

# Just hash
./scripts/lib/generate-hash.sh
```

**Priority Schema**: `[A-Z][0-9]{2}` (e.g., `P50`).

- `A00` = Highest priority.
- `P50` = Default starting point.
- `Z99` = Lowest priority.
- AI should "fit in" based on existing items. Higher priority means earlier letter (A-O) or lower number (00-49).

**Rules**:

- ✅ Use scripts (collision-free hashes, validation)
- ❌ Never create +pm files manually
- ❌ Never generate hashes yourself

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
