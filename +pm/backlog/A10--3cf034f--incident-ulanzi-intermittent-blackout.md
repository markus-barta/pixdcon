# Incident: Ulanzi devices go dark intermittently

**Priority**: A10
**Status**: Active Incident
**Created**: 2026-03-20
**Severity**: Medium (user-visible, self-recoverable via stop+play)

---

## Timeline

| When | What |
|------|------|
| ~2026-03-19 night | bz + ki went dark overnight |
| 2026-03-20 morning | Markus pressed stop → play on both → restored |
| 2026-03-20 evening | bz dark again (ki not checked) |

## Symptoms

- Ulanzi/AWTRIX display goes completely black (no scene rendering)
- Pressing "play" in pidicon web UI does nothing
- Pressing "stop" then "play" restores the scene
- Happens multiple times per day and overnight
- Affects at least `bz` device, possibly `ki` too

## Workaround

Stop + Play via pidicon web UI.

## Investigation

See: `A20--0b7a2d7--ulanzi-scene-goes-dark-investigation.md`
