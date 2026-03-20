# Investigation: Ulanzi scene goes dark intermittently

**Priority**: A20
**Status**: In Progress
**Created**: 2026-03-20

---

## Problem

Ulanzi/AWTRIX devices go dark after hours of operation. Pressing "play" does nothing; "stop → play" recovers.

## Root Cause Analysis

### Finding 1: `drawCustom` silently swallows HTTP failures

`UlanziDriver.drawCustom()` (lib/ulanzi-driver.js:67) catches errors and returns `false` — but **no scene checks the return value**. Both `clock.js` and `clock_with_homestats.js` do:

```js
await device.drawCustom({ ... });
return 1000;  // always returns interval, even if drawCustom failed
```

The render loop sees a successful render (no exception thrown, positive return value). `_handleSuccess()` runs, error counters stay at 0, backoff never triggers. **The loop thinks everything is fine while the device receives nothing.**

### Finding 2: play→play is a no-op

`setMode("play")` in render-loop.js:139 sets `_mode = "play"` and wakes any sleeper. But the frame loop only calls `_applyPlay()` (which re-initializes the device: power on + switchToApp) on transitions from **stop→play** or **pause→play**.

If the loop is already in `_mode === "play"` and you press play again — nothing happens. The loop is happily iterating, calling `drawCustom`, getting `false` back, ignoring it.

### Finding 3: AWTRIX built-in app rotation

AWTRIX firmware has built-in app cycling. If pidicon stops sending `switchToApp` calls (e.g. because drawCustom fails), the device reverts to its internal clock/notification rotation and may eventually show nothing or go dark (depending on configured apps + auto-brightness).

### Why stop→play works

1. `stop` → `_applyStop()` → `clear()` + `setPower(false)`
2. Loop enters `_waitForModeChange()` (blocks)
3. `play` → wakes the wait → `_applyPlay()` → `initialize()` + `setPower(true)` + `switchToApp()`
4. Loop restarts from scratch — fresh state

## Proposed Fix

### Short-term (render-loop.js)
- In `setMode("play")`: if already playing, set a `_reinitRequested` flag
- In frame loop: check flag before each render, call `_applyPlay()` if set
- This makes "play while playing" act as a device recovery command

### Medium-term (ulanzi-driver.js + scenes)
- `drawCustom()` should **throw** on HTTP failure (or at minimum, scenes should check return)
- This would trigger the existing error→backoff→circuit-breaker→power-cycle chain
- Alternatively: add a health-check watchdog that detects N consecutive `false` returns

### Long-term
- Periodic device liveness probe (e.g. `getStats()` every 60s)
- If device unreachable or in wrong app → auto `_applyPlay()`

## Implementation

- [ ] Make play→play trigger `_applyPlay()` (render-loop.js)
- [ ] Make `drawCustom` throw on failure (ulanzi-driver.js)
- [ ] Add logs for drawCustom returning false
- [ ] Test recovery scenario
- [ ] Deploy + monitor

## Notes

- AWTRIX firmware likely has screensaver/auto-brightness that could also blank the display
- WiFi microcuts on the Ulanzi could cause transient HTTP failures
- The Pixoo driver (`pixoo-driver.js`) throws on failure — only Ulanzi swallows errors
