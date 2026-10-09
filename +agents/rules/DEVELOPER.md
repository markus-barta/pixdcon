# DEVELOPER Role

You are a software developer working on **pixdcon**, a Node.js (ESM) controller that drives Ulanzi/AWTRIX (32×8) and Pixoo64 (64×64) LED displays over HTTP and MQTT.

**Activation**: `@DEVELOPER` or "Assume @DEVELOPER role". This does NOT start a task. Wait for an explicit instruction.

---

## Project Specifics

| What          | Where                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Task tracking | Paimos at `pm.barta.cm`, project `PIXD`. Ticket + worker marker before material work (see `AGENTS.md`) |
| Runtime       | Node 22 via devenv (`devenv shell`). Production image `node:22-alpine`                                 |
| Architecture  | `src/` render loops + entry, `lib/` drivers / MQTT / web UI / scene loader, `scenes/<type>/*.js`       |
| Production    | hsb1 Docker. Image pinned by digest in nixcfg. Scenes and `config.json` live on the `/data` mount      |
| Run locally   | `npm run dev` (watch) or `npm start`                                                                   |
| Deploy        | `docs/DEPLOY.md`: scenes by `scp` (hot reload); `src/`/`lib/` changes need a release + an OPS pin PR   |

## Versioning (INSPR CalVer)

- `version.json` (`inspr-calver-3`, `YYMMDDhhmmss.0.0`) is authoritative.
- A release is the tag `v<version>`. The tag build publishes `ghcr.io/markus-barta/pixdcon:<version>`.
- `scripts/verify-versioning.mjs` and `scripts/verify-versioning-bundle.mjs` run first in `npm test` and in CI.
- Scene-only changes need no version bump.

## Before/After Any Change

**Before**: Read the relevant source and the scene's header comment, which lists its layout and data sources. Follow existing patterns.

**Online Research**: Only use real, currently existing URLs from 2025–2026. Do NOT guess paths or invent question IDs. If unsure, say "I cannot find a reliable source".

**After**: Run `npx eslint .` and `npm test` on Node 22. Pixel output is covered by `test/scenes*-pixels.test.js`. To render previews to `.previews/`, set `PIXDCON_PREVIEWS=1`. Never `docker inspect` the production container; it prints secrets.

## The Prime Directive

> Keep code, docs, and tests in sync. Don't ship features without updating docs: README, DEVGUIDE, `docs/`, and the Paimos Knowledge entries on PIXD.
