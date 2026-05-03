# clarify-scene-deploy-source-of-truth

**Priority**: P50
**Status**: Done (docs)
**Created**: 2026-03-14
**Resolved**: 2026-05-03

---

## Problem

Two ambiguities bit us during past scene rewrites:

1. **`config.json` source of truth.** The repo's `config.json` is a stripped-down dev sample (e.g. on 2026-05-03 it had only `ulanzi-56`); the deployed file at `mba@hsb1:~/docker/mounts/pixdcon/config.json` is the real one and is edited live by the web UI. Overwriting blindly via `scp config.json hsb1:...` reverts UI-saved settings.
2. **Scene hot-reload mechanics.** It was unclear whether `scp scenes/foo.js` to the live mount is enough or whether a `touch config.json` / restart is required. Backlog item `P50--49770cc--scene-hot-reload-esm-cache-bust` already shipped the ESM cache-bust fix in `lib/scene-loader.js:120-122`, so `scp` alone is sufficient — but that wasn't documented.

## Solution

Documented the source-of-truth split + hot-reload pipeline in `docs/DEPLOY.md`:

- New "Source of truth — read this first" section with a per-asset table.
- New "Scene hot-reload — how it actually works" section explaining `ScenesWatcher` → `clearScene` → `?t=<token>` import → fresh module.
- New "Iterative scene rewrite" recipe with snapshot + rollback steps for v2-style rewrites.
- `config.json` deploy section now starts with a **pull-before-push** warning and explicit `scp` commands.
- README points to the same in its deployment block.

## Implementation

- [x] `docs/DEPLOY.md` — source-of-truth section + per-asset table
- [x] `docs/DEPLOY.md` — scene hot-reload mechanics
- [x] `docs/DEPLOY.md` — v2/iterative scene rewrite recipe
- [x] `docs/DEPLOY.md` — config.json pull-before-push warning
- [x] `README.md` — deployment block updated to match

## Acceptance Criteria

- [x] Anyone reading `docs/DEPLOY.md` cold can answer: "where does live config live?", "is `scp` to the host mount enough for a scene change?", "how do I roll back a broken scene fast?"
- [x] Repo `config.json` clearly flagged as dev-only, not the live truth.

## Notes

Discovered while planning a `home.js` v2 rewrite (2026-05-03). Verified live state: container is `ghcr.io/markus-barta/pixdcon:latest` (built 2026-04-25), live config has 4 devices, host scenes dir mtime confirms hot-reload path is in active use.
