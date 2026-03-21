# Incident: Ulanzi devices go dark intermittently

**Priority**: A10
**Status**: Resolved
**Created**: 2026-03-20
**Resolved**: 2026-03-21

---

## Timeline

| When | What |
|------|------|
| ~2026-03-19 night | bz + ki went dark overnight |
| 2026-03-20 morning | Markus pressed stop → play on both → restored |
| 2026-03-20 evening | bz dark again (ki not checked) |
| 2026-03-20 17:45 | Deployed pidicon fixes: throw-on-error + play→play recovery |
| 2026-03-21 | Root cause found: HA "Everyone Left" automation → `light.turn_off all` |
| 2026-03-21 | Automation deleted from HA, HA restarted |
| 2026-03-21 | Documented in nixcfg `hosts/hsb1/docs/AUTOMATIONS.md` |

## Root Cause

**HA automation `🧙🏻‍♂️ Everyone Left - All Lights Off`** used `light.turn_off target: entity_id: "all"` when WiFi presence dropped to 0. This killed AWTRIX matrix power (`MATP=false`) via MQTT autodiscovery. pidicon saw no HTTP errors — AWTRIX accepts frames fine with matrix off.

## Resolution

1. Deleted the HA automation (unreliable WiFi presence + `entity_id: "all"` = bad combo)
2. Created `AUTOMATIONS.md` in nixcfg with anti-patterns documentation
3. pidicon hardened: drawCustom/push now throw on HTTP failure, play→play triggers device re-init

## Investigation

See: `A20--0b7a2d7--ulanzi-scene-goes-dark-investigation.md`
