/**
 * pixdcon 2.0: shared types (JSDoc only, no runtime code).
 *
 * This file is the contract between the phase-3 workers. Import a type with
 *   @param {import("../types.js").DeviceView} view
 * Owner: the core/state worker. Others ask for a change instead of editing it.
 * Rationale, tables and matrix row ids: PAIMOS knowledge "guideline
 * pixdcon-2-interfaces" (project PIXD).
 */

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

/** @typedef {"ulanzi"|"pixoo"} DeviceType v1 config values; "ulanzi" = Ulanzi TC001 / AWTRIX 32×8, "pixoo" = Pixoo64 64×64 */
/** @typedef {"drive"|"shadow"} OutputMode drive = v2 owns the display; shadow = render and preview only, nothing is written to the display or to MQTT */
/** @typedef {"play"|"pause"|"stop"} PlaybackMode v1 values of `<base>/<device>/mode` */
/** @typedef {string} IsoTime ISO-8601 UTC, e.g. "2026-11-16T17:42:06.120Z" */
/** @typedef {string} SceneRef a registered scene key, "builtin:<mode>", or "" for none in wire payloads */

/**
 * @typedef {object} Logger
 * @property {(msg: string, err?: unknown) => void} error
 * @property {(msg: string) => void} warn
 * @property {(msg: string) => void} info
 * @property {(msg: string) => void} debug
 */

/**
 * @typedef {object} Clock Injected time source; tests replace it to drive stale/offline timing without waiting.
 * @property {() => number} now epoch ms
 * @property {(ms: number, signal?: AbortSignal) => Promise<boolean>} sleep resolves true when the time passed, false when aborted
 * @property {(fn: () => void, ms: number) => {cancel: () => void}} every repeating timer that never keeps the process alive
 */

// ---------------------------------------------------------------------------
// Saved state: config.json (the one saved state, written atomically)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PowerCyclePlugin
 * @property {string} topic exact MQTT topic of the smart plug, e.g. "z2m/wz/plug/zisp32/set"
 * @property {string} [offPayload] default '{"state":"OFF"}'
 * @property {string} [onPayload] default '{"state":"ON"}'
 * @property {number} [offWaitMs] default 10000
 * @property {number} [onWaitMs] default 30000
 */

/**
 * One device entry of config.json after normalisation. The v1 keys keep their
 * names and meaning (matrix A-042 to A-057); `enabled`, `output` and
 * `supersedes` are v2 keys that v1 ignores.
 *
 * @typedef {object} DeviceConfig
 * @property {string} name unique; /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/ (safe in MQTT topics, URLs and as an object key)
 * @property {DeviceType} type
 * @property {string} ip host or host:port of the display (v1 key name kept)
 * @property {string|null} scene "Your choice": scene key, "builtin:<mode>" or null. A legacy `scenes` array is read as its first element (A-046).
 * @property {string} displayName
 * @property {string} comment
 * @property {{showGrid: boolean, pollMs: number}} preview pollMs 1000 to 10000, default 2000 (Ulanzi screen read-back)
 * @property {Record<string, Record<string, unknown>>} sceneSettings saved settings: scene key → setting key → value
 * @property {number} minFrameMs default 500
 * @property {number} maxPowerCycles default 10
 * @property {PowerCyclePlugin|null} powerCyclePlugin
 * @property {boolean} cleanupLegacyApps default false (Ulanzi only)
 * @property {boolean} enabled default true; false keeps the entry in the file and does not start the device (A-075)
 * @property {OutputMode} output default from `Config.output.default`
 * @property {{scene?: IsoTime}} supersedes bookkeeping written together with a UI choice: scene overlays stored before this instant are stale until the broker confirmed the clear
 */

/**
 * @typedef {object} MqttConfig
 * @property {string} baseTopic default "home/hsb1/pixdcon": overlays, per-device controls and telemetry (v1 wire contract)
 * @property {string} statusBaseTopic default = baseTopic: controller-level health, state, config. Another value (e.g. "home/hsb1/pixdcon2") while v1 still publishes them.
 * @property {string} settingsBaseTopic default "pixdcon": `<settingsBaseTopic>/<device>/<scene>/settings/<key>`
 * @property {string} discoveryPrefix default "homeassistant"
 * @property {boolean} haDiscovery default true
 */

/**
 * @typedef {object} HealthConfig
 * @property {number} staleAfterMs default 30000 (Markus, PIXD-81 approval)
 * @property {number} offlineAfterMs default 120000
 * @property {number} probeIntervalMs default 10000
 */

/**
 * The whole saved state. Unknown keys are kept on rewrite and reported as warnings.
 *
 * @typedef {object} Config
 * @property {DeviceConfig[]} devices
 * @property {Record<string, {path: string}>} scenes scene key → file, path relative to the directory of config.json (A-055)
 * @property {number} telemetryIntervalMs default 60000
 * @property {MqttConfig} mqtt
 * @property {HealthConfig} health
 * @property {{default: OutputMode}} output default "drive"; the edge lane sets "shadow"
 */

/**
 * What changed between two valid configs. Drives per-device application: only
 * the named devices are touched (matrix A-030, B-047).
 *
 * @typedef {object} ConfigDiff
 * @property {string[]} devicesAdded
 * @property {string[]} devicesRemoved
 * @property {Record<string, string[]>} devicesChanged device name → changed top-level keys
 * @property {string[]} scenesAdded
 * @property {string[]} scenesRemoved
 * @property {string[]} scenesChanged scene keys whose path changed
 * @property {string[]} globalChanged changed top-level keys other than devices and scenes
 */

/**
 * @typedef {object} ConfigFileState State of config.json on disk, for the raw editor and the title line.
 * @property {string} path
 * @property {boolean} valid false: the file on disk is unusable and the last valid config keeps running
 * @property {{message: string, line: number|null, column: number|null}|null} error
 * @property {IsoTime|null} loadedAt when the running config was loaded or written
 * @property {IsoTime|null} invalidSince
 * @property {string[]} warnings unknown keys, scene references that match no registered scene
 */

// ---------------------------------------------------------------------------
// Overlays: the retained MQTT layer (never written into config.json)
// ---------------------------------------------------------------------------

/**
 * @typedef {"device-scene"|"device-ip"|"device-enabled"|"scene-path"|"blob"|"setting"|"mode"|"brightness"} OverlayKind
 */

/**
 * One stored value from an outside MQTT client, or one retained control.
 *
 * @typedef {object} OverlayRecord
 * @property {string} id stable and URL-safe, e.g. "device-scene:ulanzi-57", "setting:ulanzi-56:clock_with_homestats:night_start_hour", "blob"
 * @property {OverlayKind} kind
 * @property {string} topic full MQTT topic
 * @property {string|null} device
 * @property {string|null} scene
 * @property {string|null} key setting key
 * @property {string} raw payload text as received
 * @property {unknown} value parsed and normalised value; null when it was rejected
 * @property {boolean} valid
 * @property {string|null} problem why it is not valid or not in effect, e.g. "unknown device", "unknown scene", "no schema for this key yet"
 * @property {IsoTime} receivedAt when this process received it
 * @property {"startup"|"live"} origin startup = retained replay after a (re)connect, set at an unknown earlier time; live = published while connected
 * @property {boolean} inEffect true while it decides what a display shows
 * @property {"ui-choice"|null} supersededBy set when a UI choice replaced it and the retained clear is still on its way
 * @property {{pending: boolean, requestedAt: IsoTime|null, attempts: number}} clear
 */

// ---------------------------------------------------------------------------
// Device state: desired, effective, health
// ---------------------------------------------------------------------------

/**
 * Where the scene on a display comes from. UI wording in brackets.
 *  - "ui":       chosen in the UI or through the API in this process ("Your choice", "Switched here … not saved")
 *  - "config":   `scene` in config.json as loaded ("Your choice, saved in config.json")
 *  - "overlay":  retained `<base>/overlay/device/<name>/scene` ("MQTT overlay since …")
 *  - "blob":     device entry of retained `<base>/overlay/blob` ("Config overlay")
 *  - "fallback": nothing decides: no choice and no overlay, so the display idles ("Nothing")
 * @typedef {"ui"|"config"|"overlay"|"blob"|"fallback"} SceneSource
 */

/**
 * Result of the scene precedence for one device. Pure function of the inputs,
 * see state/precedence.js.
 *
 * @typedef {object} SceneResolution
 * @property {string|null} scene what the display should show
 * @property {SceneSource} source
 * @property {IsoTime} since when this source started to decide
 * @property {string|null} overlayId the overlay record in effect, if any
 * @property {string|null} problem set when the winning value cannot run: "unknown scene", "wrong device type", "scene is broken: …"
 */

/**
 * What the user chose, independent of what is showing.
 *
 * @typedef {object} SceneChoice
 * @property {string|null} scene `scene` of the device in config.json, or the live choice when it could not be saved
 * @property {boolean} persisted false: switched but not saved because config.json is invalid (v1 `persisted: false`, A-150)
 * @property {IsoTime|null} chosenAt set for a choice made in this process
 * @property {boolean} overridden true while an overlay shows something else
 */

/**
 * @typedef {object} DesiredState What a device should do. Every field names its source.
 * @property {SceneResolution} scene
 * @property {SceneChoice} choice
 * @property {{value: PlaybackMode, source: "default"|"mqtt"|"ui", since: IsoTime}} mode default play; "mqtt" = retained control from another client, "ui" = set through this API
 * @property {{override: number|null, source: "none"|"mqtt"|"ui", since: IsoTime}} brightness override in percent 1 to 100, null = the scene decides
 * @property {{value: string, source: "config"|"blob"|"overlay"}} address effective host[:port] (D-188)
 * @property {boolean} enabled
 * @property {OutputMode} output after the global shadow switch and the transition interlock were applied
 * @property {string|null} outputProblem why a device that config.json wants driven is in shadow, e.g. "still driven by pixdcon v1"
 */

/**
 * @typedef {"idle"|"starting"|"running"|"paused"|"stopped"|"builtin"|"retrying"|"exhausted"} LoopPhase
 * idle = no scene; starting = scene loading or first frame not out yet; retrying = in backoff after an error;
 * exhausted = power cycles used up, slow probing continues (v1 "dead", B-035)
 */

/**
 * @typedef {object} EffectiveState What the render loop reports is really happening.
 * @property {string|null} scene scene instance that is loaded, or the built-in mode
 * @property {LoopPhase} phase
 * @property {IsoTime|null} showingSince when the current scene produced its first frame
 * @property {number} frameCount successful frames since the loop started
 * @property {number|null} lastBrightness percent the scene last asked for, null when it never did
 * @property {number|null} appliedBrightness percent last accepted by the display
 * @property {IsoTime|null} nextRetryAt
 */

/**
 * Measured health of one display (matrix B-066, S-14; thresholds from Markus: stale 30 s, offline 2 min).
 *
 * @typedef {"starting"|"online"|"stale"|"offline"|"idle"|"shadow"} HealthState
 * shadow = not measured: this instance does not talk to the display
 *
 * @typedef {object} DeviceHealth
 * @property {HealthState} state
 * @property {IsoTime} since when this state began ("Offline since 18:28:03")
 * @property {IsoTime|null} lastFrameAt last frame the display accepted
 * @property {IsoTime|null} lastContactAt last successful exchange of any kind: frame, probe or telemetry read
 * @property {number} consecutiveErrors failed renders in a row
 * @property {{message: string, kind: "device"|"scene"|"config"|"internal", at: IsoTime}|null} lastError
 * @property {"device_unreachable"|"scene_error"|"power_cycles_exhausted"|"not_started"|null} reason why the display is not online
 * @property {{count: number, max: number, plugTopic: string|null}} powerCycles
 * @property {string|null} apSsid AWTRIX access-point network name from the last telemetry read (uid), for the recovery dialog
 */

/**
 * @typedef {object} DeviceState Everything the core knows about one device. Kept by state/state-store.js.
 * @property {string} name
 * @property {DeviceType} type
 * @property {number} rev increases with every change of this device; clients drop answers with an older rev (build rule 3)
 * @property {DesiredState} desired
 * @property {EffectiveState} effective
 * @property {DeviceHealth} health
 */

/**
 * JSON view of a device for the API and the live channel: DeviceState plus the
 * fields of config.json the UI shows. This is what every write answers with,
 * so a form never falls back to old values (matrix S-1).
 *
 * @typedef {object} DeviceView
 * @property {string} name
 * @property {string} displayName
 * @property {string} comment
 * @property {DeviceType} type
 * @property {{width: number, height: number}} size
 * @property {number} rev
 * @property {DesiredState} desired
 * @property {EffectiveState} effective
 * @property {DeviceHealth} health
 * @property {{showGrid: boolean, pollMs: number}} preview
 * @property {{minFrameMs: number, powerCyclePlugTopic: string|null}} facts
 * @property {number} settingOverlayCount outside setting overlays on the showing scene ("1 setting from an MQTT overlay")
 * @property {{op: "scene"|"mode"|"brightness"|"retry", target: string|null, startedAt: IsoTime}|null} pending "Switching to …"
 */

// ---------------------------------------------------------------------------
// Scenes and settings
// ---------------------------------------------------------------------------

/**
 * Normalised field of a scene's `settingsSchema` (v1: matrix A-084, B-011).
 *
 * @typedef {object} SettingField
 * @property {"int"|"float"|"boolean"|"enum"|"time"|"json"|"color"|"string"} type default "string"
 * @property {string} label default: the key
 * @property {string} group default "General"
 * @property {string} description
 * @property {unknown} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {Array<string|number|{value: string|number, label?: string}>} [options]
 * @property {string} placeholder
 */

/**
 * @typedef {object} SceneMeta
 * @property {string} key
 * @property {string} path as written in config.json
 * @property {string} name
 * @property {string} pretty_name
 * @property {string} description
 * @property {DeviceType|null} deviceType UI filter only, not enforced (v1)
 * @property {Record<string, SettingField>} settingsSchema
 * @property {"ok"|"broken"} status broken: import failed, no render(), or invalid schema (B-010, B-166, A-183)
 * @property {string|null} error
 */

/**
 * @typedef {object} BuiltinMode
 * @property {string} key "builtin:clock", …
 * @property {string} label
 * @property {number} [channel] Pixoo channel index
 * @property {string} [app] AWTRIX app name
 */

/**
 * One setting of one scene on one device, with every layer visible.
 * Precedence, lowest first: default < saved < overlay < preview.
 *
 * @typedef {object} SettingValue
 * @property {unknown} default
 * @property {unknown} [saved] present when config.json holds a valid value
 * @property {unknown} [overlay] present when an outside MQTT overlay is stored
 * @property {unknown} [preview] present while a preview session tries a value
 * @property {unknown} effective what the scene sees
 * @property {"default"|"saved"|"overlay"|"preview"} source
 */

/**
 * @typedef {object} SettingsState
 * @property {string} device
 * @property {string} scene
 * @property {number} rev
 * @property {Record<string, SettingField>} schema
 * @property {Record<string, SettingValue>} values
 * @property {string|null} previewSession id of the session whose preview values are in effect
 */

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Frame An RGB888 picture as a scene rendered it.
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} rgb width × height × 3 bytes, row-major
 */

/**
 * @typedef {object} PreviewFrame
 * @property {string} device
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} rgb
 * @property {"runtime"|"device"|"simulated"} source runtime = Pixoo buffer as pushed; device = AWTRIX screen read back; simulated = rasterised AWTRIX app (shadow and fake devices)
 * @property {IsoTime} receivedAt when a frame was last received; says nothing about when the picture changed (B-172)
 * @property {number} seq increases per device with every stored frame
 */

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MqttStatus
 * @property {"disabled"|"connecting"|"connected"|"offline"} state disabled = no broker configured (v1: MOSQUITTO_PASS not set)
 * @property {string|null} url without credentials
 * @property {IsoTime|null} since when this state began
 * @property {{message: string, at: IsoTime}|null} lastError
 * @property {boolean} bootstrapped true once the retained messages of the current connection have been read
 */

/**
 * @typedef {object} ControllerStatus
 * @property {string} instance "pixdcon2" or "pixdcon2-edge"
 * @property {string} version release coordinate from version.json
 * @property {string} version_scheme "inspr-calver-3"
 * @property {IsoTime} startedAt
 * @property {"ok"|"degraded"|"failed"} status measured: event loop, render loops, config, MQTT
 * @property {boolean} forceShadow true when PIXDCON2_FORCE_SHADOW is set: no device of this instance is driven
 */

/**
 * One line of the process log, kept in a ring for Health › Recent log.
 *
 * @typedef {object} LogLine
 * @property {number} seq
 * @property {IsoTime} at
 * @property {"ERROR"|"WARN"|"INFO"|"DEBUG"} level
 * @property {string} message with its component prefix, e.g. "[MQTT] Connected"
 */

/**
 * Everything a page needs, in one answer (GET /api/v2/bootstrap) and as the
 * first event of the live channel.
 *
 * @typedef {object} Snapshot
 * @property {number} seq position in the live channel; events with a lower or equal seq are already included
 * @property {ControllerStatus} controller
 * @property {MqttStatus} mqtt
 * @property {ConfigFileState} config
 * @property {DeviceView[]} devices in config order
 * @property {SceneMeta[]} scenes
 * @property {Record<DeviceType, BuiltinMode[]>} builtins
 * @property {OverlayRecord[]} overlays
 */

/**
 * Events of the live channel (GET /api/v2/events, server-sent events).
 * `id:` of every event is its seq; `event:` is the type below.
 *
 * @typedef {{type: "snapshot", seq: number, data: Snapshot}
 *   | {type: "device", seq: number, data: DeviceView}
 *   | {type: "device-removed", seq: number, data: {name: string}}
 *   | {type: "preview", seq: number, data: {device: string, width: number, height: number, source: PreviewFrame["source"], receivedAt: IsoTime, frameSeq: number, rgbBase64: string}}
 *   | {type: "overlays", seq: number, data: OverlayRecord[]}
 *   | {type: "settings", seq: number, data: SettingsState}
 *   | {type: "scenes", seq: number, data: SceneMeta[]}
 *   | {type: "config", seq: number, data: ConfigFileState & {reload: {at: IsoTime, ok: boolean, devicesRunning: number, message: string|null}|null}}
 *   | {type: "mqtt", seq: number, data: MqttStatus}
 *   | {type: "controller", seq: number, data: ControllerStatus}
 *   | {type: "log", seq: number, data: LogLine}
 *   | {type: "ping", seq: number, data: {at: IsoTime}}} LiveEvent
 */

export {};
