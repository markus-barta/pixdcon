# scene-hot-reload-esm-cache-bust

**Priority**: P50
**Status**: Backlog
**Created**: 2026-03-05

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

- [ ] `scp scene.js` + `touch config.json` picks up new scene code without `docker restart`
- [ ] No regression on normal startup / first load

## Notes

Discovered during `home.js` scene rewrite (export default pattern change not picked up).
Only affects scene file changes — config.json changes work fine today.
