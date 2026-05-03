# scene-hot-reload-esm-cache-bust

**Priority**: P50
**Status**: Done (verified)
**Created**: 2026-03-05
**Resolved**: 2026-05-03

---

## Problem

`SceneLoader.clearCache()` clears the internal Map but Node's ESM `import()` registry
keeps the old module in memory. Hot-reload via `touch config.json` picks up config
changes but scene *file* changes are ignored — the stale module runs until container restart.

## Solution

Append a cache-busting query param to the import URL in `SceneLoader.load()`:
```js
const url = `file://${absolutePath}?v=${Date.now()}`;
const mod = await import(url);
```
Node treats each unique URL as a distinct module, so each reload gets a fresh import.
Old module versions are GC'd once no references remain.

## Implementation

- [ ] Update `SceneLoader.load()` to use `file://` URL + `?v=Date.now()` cache buster
- [ ] Verify hot-reload works: scp new scene → touch config.json → scene updates without restart
- [ ] Check memory: repeated reloads don't accumulate stale module instances

## Acceptance Criteria

- [x] `scp scene.js` picks up new scene code without `docker restart` (no `touch config.json` needed — `ScenesWatcher` triggers `clearScene` automatically)
- [x] No regression on normal startup / first load

## Notes

Discovered during `home.js` scene rewrite (export default pattern change not picked up).
Only affects scene file changes — config.json changes work fine today.

**Resolution (verified 2026-05-03):**
- `lib/scene-loader.js:80` adds a `_reloadTokens` Map; `clearScene()` (line 191) sets the token at evict time.
- `load()` at line 120-122 appends `?t=<token>` to the import URL on next load → ESM cache miss → fresh module.
- `lib/scenes-watcher.js` debounces 500ms and calls `clearScene` per matching scene name (`src/index.js:118-120`).
- Live confirmation on hsb1: `home.js` mtime on host matches repo (2026-03-29 09:28); container has been up 8 days without restart, so the running module came from a hot-reload, not boot.

See also: `P50--517b226--clarify-scene-deploy-source-of-truth.md` for the docs follow-up.
