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
 * Identity of one run of the process. A new value at every start (random, 8
 * hex characters). Every counter a client keeps (`rev` of a view, `seq` of the
 * live channel) is only comparable inside one epoch: the counters start again
 * with the process, so a number from an earlier run says nothing (B-177).
 *
 * @typedef {string} Epoch
 */

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

/** @typedef {"granular"|"blob"} SceneLayer the two places a scene overlay can be stored: `<base>/overlay/device/<name>/scene`, and the device's entry in `<base>/overlay/blob` */

/**
 * "This UI choice replaced what was stored in that layer." One per device and
 * layer, written into config.json in the same atomic write as the choice and
 * removed by a small atomic write when it ends. While it exists, a replay of
 * the replaced value is stale: it is not shown and it is cleared again.
 *
 * It ends only on evidence, never on a timer, on the settle hint or because
 * no message arrived (overlay/overlay-service.js, rules S1 to S5):
 *  - the broker confirmed the clear (or blob rewrite) that carries the same `generation`
 *  - an outside client published to the layer while pixdcon was connected (a new command)
 *  - a replay carries another value than `value` (stored while pixdcon was away: a new command)
 *  - blob only: a blob arrives that has no scene for the device
 *  - a newer choice replaces it; the device leaves config.json; the device becomes driven after a choice made in shadow
 *
 * @typedef {object} SceneSuppression
 * @property {number} generation choice generation of the device, rising with every UI choice; an acknowledgement ends only the suppression of its own generation
 * @property {IsoTime} at time of the choice
 * @property {string|null} value the stored value the choice replaced (granular: the payload; blob: the device's scene in the blob). null = not known at the time of the choice: anything stored in this layer is stale
 * @property {OutputMode} output output of the device when the choice was made. A suppression made in shadow never deletes anything on the broker, not even later: it is dropped when the device becomes driven
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
 * @property {OutputMode|null} output what the file asks for; null = not said, the default applies. The output in effect is `EffectiveDevice.output` (one resolved policy).
 * @property {{granular?: SceneSuppression, blob?: SceneSuppression}} supersedes bookkeeping written together with a UI choice, one entry per scene layer; only suppressions whose clear is not confirmed yet are in the file
 */

/**
 * The MQTT namespace. Read once, after config.json was loaded and before the
 * topics, the last will and the gateway are built (main.js). It is fixed for
 * the life of the process: a change in config.json is reported as
 * `ControllerStatus.restartRequired` and takes effect at the next start.
 *
 * @typedef {object} MqttConfig
 * @property {string} baseTopic default "home/hsb1/pixdcon": overlays, per-device controls and telemetry (v1 wire contract)
 * @property {string} statusBaseTopic default = baseTopic: controller-level health, state, config. Another value (e.g. "home/hsb1/pixdcon2") while v1 still publishes them; that difference is also what turns the transition interlock on.
 * @property {string} settingsBaseTopic default "pixdcon": `<settingsBaseTopic>/<device>/<scene>/settings/<key>`
 * @property {string} discoveryPrefix default "homeassistant"
 * @property {boolean} haDiscovery default true
 */

/**
 * Markus's rule, literally (PIXD-81 approval): a display with an active scene
 * is stale 30 s and offline 2 min after its last good frame. No exception for
 * a scene that asks for a long delay.
 *
 * @typedef {object} HealthConfig
 * @property {number} staleAfterMs default 30000
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
 * @property {{default: OutputMode|null}} output null = not said: PIXDCON2_DEFAULT_OUTPUT decides, else "drive"; the edge lane sets "shadow"
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
// Effective runtime config: config.json with the structural overlays applied
// ---------------------------------------------------------------------------

/**
 * Who drives a display during the switch-over from v1 (state/v1-ownership.js).
 *  - "free":    v1 does not list the device, or no transition is configured
 *  - "v1":      v1's retained `<baseTopic>/config/effective` lists the device
 *  - "unknown": the transition is on and v1's list has not been received in this process
 * @typedef {"free"|"v1"|"unknown"} V1Owner
 */

/**
 * The one answer to "may this instance touch the display and the broker for
 * this device". Resolved in one place (state/precedence.js resolveOutput,
 * served by state/runtime-config.js) and used by everything that acts
 * outward: driver choice, overlay clears and controls, telemetry, discovery,
 * status topics, the power-cycle plug and scene state files.
 *
 * `mode` is "shadow" as soon as one of these holds, in this order:
 *   force_shadow        PIXDCON2_FORCE_SHADOW=1
 *   config              the device, `output.default` or PIXDCON2_DEFAULT_OUTPUT asks for shadow
 *   v1_owner            transition: v1 still lists the device ("still driven by pixdcon v1")
 *   ownership_unknown   transition: v1's list is not known yet. Unknown means shadow.
 *
 * @typedef {object} OutputDecision
 * @property {OutputMode} mode
 * @property {OutputMode} requested what config.json and the defaults ask for
 * @property {"force_shadow"|"config"|"v1_owner"|"ownership_unknown"|null} reason null when driven
 */

/**
 * One device as it runs: config.json entry < blob overlay entry < granular
 * overlays (ip, enabled), validated and typed. This is what the scheduler,
 * the drivers, telemetry and the status topics work from; none of them reads
 * the saved config for a device or rebuilds this from overlay records.
 *
 * A blob entry may patch every key of a device and may add a device that
 * config.json does not have (A-071, C-055). Such a device has origin "blob".
 * The scene is not in here: it has its own precedence over time
 * (`DesiredState.scene`).
 *
 * @typedef {object} EffectiveDevice
 * @property {string} name
 * @property {DeviceType} type
 * @property {"config"|"blob"} origin where the entry itself comes from; "blob" = it exists only in the blob overlay and nothing can be saved for it until it is adopted (A-151)
 * @property {string} address effective host[:port]
 * @property {"config"|"blob"|"overlay"} addressSource
 * @property {boolean} enabled false: the entry exists and no runtime is started
 * @property {"config"|"blob"|"overlay"} enabledSource
 * @property {OutputDecision} output
 * @property {string} displayName
 * @property {string} comment
 * @property {{showGrid: boolean, pollMs: number}} preview
 * @property {number} minFrameMs
 * @property {number} maxPowerCycles
 * @property {PowerCyclePlugin|null} powerCyclePlugin
 * @property {boolean} cleanupLegacyApps
 * @property {Record<string, Record<string, unknown>>} sceneSettings the saved layer as it runs; a blob entry replaces the whole object (A-071)
 * @property {string[]} blobKeys keys of this entry that the blob overlay sets, for the Overlays page; never written to config.json
 */

/**
 * @typedef {object} EffectiveScene
 * @property {string} path as given; relative paths resolve against the directory of config.json
 * @property {"config"|"blob"|"overlay"} source config.json < blob overlay < granular path overlay (A-069, A-072, C-052)
 */

/**
 * The running config with the structural overlays applied. Built by
 * state/runtime-config.js from the config store, the overlay service and the
 * v1 ownership feed. Frozen; a change produces a new object and a diff.
 *
 * @typedef {object} EffectiveConfig
 * @property {number} rev rises with every change
 * @property {EffectiveDevice[]} devices config order, then blob-only devices in blob order; disabled devices are included with enabled false
 * @property {Record<string, EffectiveScene>} scenes
 * @property {number} telemetryIntervalMs from config.json; the blob cannot change global keys (A-072)
 * @property {MqttConfig} mqtt the namespace the process started with
 * @property {HealthConfig} health
 */

/**
 * Same shape as ConfigDiff, computed on the effective entries: device keys
 * are the keys of EffectiveDevice ("address", "output", "minFrameMs", …).
 * config/schema.js changeImpact() classifies them.
 *
 * @typedef {ConfigDiff} EffectiveDiff
 */

/**
 * What the overlay layer contributes to the effective config, already checked
 * entry by entry with v1's rules (A-070 to A-072).
 *
 * @typedef {object} StructuralOverlays
 * @property {Array<Record<string, unknown> & {name: string}>} blobDevices usable entries of the blob's `devices`, in blob order; an entry patches the device of that name or, with name, type and ip, adds one
 * @property {Record<string, {path: string}>} blobScenes
 * @property {Record<string, string>} scenePaths granular scene path overlays: scene key → path
 * @property {Record<string, string>} deviceIps granular ip overlays: device → host[:port]
 * @property {Record<string, boolean>} deviceEnabled granular enabled overlays: device → false
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
 * @property {"replay"|"live"} origin how this value arrived, from the retain flag as delivered and nothing else: replay = a copy from the broker's retained store (stored at an unknown earlier time); live = published while pixdcon was subscribed
 * @property {number} connection gateway connection on which it arrived
 * @property {boolean} inEffect true while it decides what a display shows
 * @property {{generation: number, at: IsoTime}|null} supersededBy the UI choice that replaced it, while its clear is on its way. For the blob record: null; the per-device answer is `OverlayService.suppressions(device)`.
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
 * @property {boolean} persisted false: switched but not saved (v1 `persisted: false`, A-150)
 * @property {"config_invalid"|"overlay_only_device"|null} notSavedReason why `persisted` is false: config.json on disk is invalid, or the device exists only in the blob overlay and was not adopted (A-151)
 * @property {IsoTime|null} chosenAt set for a choice made in this process
 * @property {boolean} overridden true while an overlay shows something else
 */

/**
 * @typedef {object} DesiredState What a device should do. Every field names its source.
 * @property {SceneResolution} scene
 * @property {SceneChoice} choice
 * @property {{value: PlaybackMode, source: "default"|"mqtt"|"ui", since: IsoTime}} mode default play; "mqtt" = retained control from another client, "ui" = set through this API
 * @property {{override: number|null, source: "none"|"mqtt"|"ui", since: IsoTime}} brightness override in percent 1 to 100, null = the scene decides
 * @property {{value: string, source: "config"|"blob"|"overlay"}} address effective host[:port] (D-188); same as `EffectiveDevice.address`
 * @property {boolean} enabled
 * @property {OutputMode} output `EffectiveDevice.output.mode`: after the force-shadow switch, the config and the transition interlock
 * @property {string|null} outputProblem why a device that config.json wants driven is in shadow: "still driven by pixdcon v1", "waiting for pixdcon v1's device list", "this instance never drives a display"
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
 * Measured health of one display (matrix B-066, S-14).
 *
 * The rule is Markus's, literally: with an active scene (mode play, a custom
 * scene) a display is stale 30 s and offline 2 min after the last frame it
 * accepted. Nothing is subtracted, whatever delay the scene asked for.
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
 * @property {number} rev rises with every change of this device, inside one epoch
 * @property {EffectiveDevice} runtime the device entry as it runs
 * @property {DesiredState} desired
 * @property {EffectiveState} effective
 * @property {DeviceHealth} health
 */

/**
 * JSON view of a device for the API and the live channel: DeviceState plus the
 * fields of config.json the UI shows. This is what every write answers with,
 * so a form never falls back to old values (matrix S-1).
 *
 * A client applies a view only when its `epoch` is the one of the snapshot it
 * holds and its `rev` is higher than the one on screen (build rule 3, B-177).
 *
 * @typedef {object} DeviceView
 * @property {string} name
 * @property {Epoch} epoch
 * @property {number} rev
 * @property {string} displayName
 * @property {string} comment
 * @property {DeviceType} type
 * @property {"config"|"blob"} origin "blob": the device exists only in the MQTT config overlay; changes are applied but not saved until it is adopted
 * @property {{width: number, height: number}} size
 * @property {DesiredState} desired
 * @property {EffectiveState} effective
 * @property {DeviceHealth} health
 * @property {{showGrid: boolean, pollMs: number}} preview
 * @property {{minFrameMs: number, powerCyclePlugTopic: string|null}} facts
 * @property {string[]} blobKeys keys of this device that the blob overlay sets
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
 * Files a scene uses beside its own file. Read from the content of the scene
 * file, not from its key, so an alias (another key for the same file) and a
 * copy carry them too (B-183). scenes/scene-registry.js fills it.
 *
 * @typedef {object} SceneResources
 * @property {string[]} assetDirs names of folders beside the scene file that it reads, e.g. ["home3-assets"]. A copy needs a folder of the same name beside it.
 * @property {string[]} stateFields instance fields that hold the path of a file the scene writes, e.g. ["_boilerStatePath"] (home2, home3: `this._boilerStatePath ??= …`). For a device in shadow output the adapter sets each of them before init.
 */

/**
 * @typedef {object} SceneMeta
 * @property {string} key
 * @property {string} path as written in config.json or in the overlay
 * @property {"config"|"blob"|"overlay"} pathSource
 * @property {string} name
 * @property {string} pretty_name
 * @property {string} description
 * @property {DeviceType|null} deviceType UI filter only, not enforced (v1)
 * @property {Record<string, SettingField>} settingsSchema
 * @property {SceneResources} resources
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
 * Identity of one scene instance. `token` is unique per instance, so the
 * instance that runs and the replacement that a hot reload is initialising
 * beside it never share an owner: each one's MQTT and settings subscriptions
 * are registered and released under its own reference.
 *
 * @typedef {object} InstanceRef
 * @property {string} scene scene key
 * @property {string} device device name
 * @property {string} token "<file token>.<counter>", e.g. "1731777726120.3"
 */

/**
 * One setting of one scene on one device, with every layer visible.
 * Precedence, lowest first: default < saved < overlay < preview.
 *
 * @typedef {object} SettingValue
 * @property {unknown} default
 * @property {unknown} [saved] present when the saved layer holds a valid value
 * @property {unknown} [overlay] present when an outside MQTT overlay is stored
 * @property {unknown} [preview] present while a preview session tries a value
 * @property {unknown} effective what the scene sees
 * @property {"default"|"saved"|"overlay"|"preview"} source
 */

/**
 * @typedef {object} SettingsState
 * @property {string} device
 * @property {string} scene
 * @property {Epoch} epoch
 * @property {number} rev
 * @property {Record<string, SettingField>} schema
 * @property {Record<string, SettingValue>} values
 * @property {"config"|"blob"} savedFrom "blob": the blob overlay replaces this device's saved settings (A-071); Save still writes config.json, the values in effect come from the blob until it is cleared
 * @property {{session: string, draft: number}|null} preview the preview in effect: the page that owns it and the number of the draft it shows. `draft` rises with every edit on that page; Save commits one draft and leaves a newer one alone (B-176).
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
// Factories: what crosses worker boundaries
// ---------------------------------------------------------------------------

/**
 * Functions one worker's module needs from another worker's module. main.js
 * imports them and hands them over through constructors, so no module imports
 * another worker's file and nobody waits for a file to exist: a worker builds
 * against the type here and tests with a stub.
 *
 * @typedef {object} Factories
 * @property {typeof import("./drivers/driver.js").createDriver} createDriver drivers worker → scheduler
 * @property {typeof import("./drivers/driver.js").sizeOf} sizeOf drivers worker → state store, preview store
 * @property {typeof import("./drivers/builtin-modes.js").findBuiltin} findBuiltin drivers worker → scene registry, state store
 * @property {typeof import("./drivers/builtin-modes.js").BUILTIN_MODES} builtinModes drivers worker → API snapshot
 * @property {(device: {name: string, type: DeviceType, address: string}, sink: import("./scenes/v1-device-facade.js").SurfaceSink) => Promise<import("./scenes/v1-device-facade.js").SceneSurface>} createSurface fixtures worker → render loop: the object a v1 scene draws on, by device type; the v1 font is loaded once
 * @property {typeof import("./drivers/awtrix-raster.js").rasterizeAwtrixApp} rasterizeAwtrixApp fixtures worker → shadow driver, preview store, fake AWTRIX
 * @property {{ulanzi: typeof import("./mqtt/ha-discovery.js").ulanziDiscovery, pixoo: typeof import("./mqtt/ha-discovery.js").pixooDiscovery}} discovery API worker → telemetry collector
 */

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MqttStatus
 * @property {"disabled"|"connecting"|"connected"|"offline"} state disabled = no broker configured (v1: MOSQUITTO_PASS not set)
 * @property {string|null} url without credentials
 * @property {IsoTime|null} since when this state began
 * @property {number} connection number of the current or last connection; 0 = never connected
 * @property {{message: string, at: IsoTime}|null} lastError
 * @property {boolean} settled pacing hint: the retained replay of the current connection has probably been delivered. Never proof that a retained message does not exist; one that arrives later is handled like any other replay.
 */

/**
 * @typedef {object} ControllerStatus
 * @property {string} instance "pixdcon2" or "pixdcon2-edge"
 * @property {Epoch} epoch
 * @property {string} version release coordinate from version.json
 * @property {string} version_scheme "inspr-calver-3"
 * @property {IsoTime} startedAt
 * @property {"ok"|"degraded"|"failed"} status measured: scheduler watchdog, displays, config, MQTT. failed = the supervision itself is overdue; GET /api/health then answers 503.
 * @property {string[]} reasons why the status is not ok: "display_offline:<name>", "display_stale:<name>", "config_invalid", "mqtt_offline", "restart_required", "watchdog_overdue"
 * @property {boolean} measured false while the health model or the scheduler is not built: `status` then only says that the process answers
 * @property {boolean} forceShadow true when PIXDCON2_FORCE_SHADOW is set: no device of this instance is driven
 * @property {{baseTopic: string, statusBaseTopic: string, settingsBaseTopic: string, discoveryPrefix: string, transition: boolean}} mqttNamespace the topics this process started with; transition = statusBaseTopic differs from baseTopic, so the v1 interlock is on
 * @property {{reason: string, since: IsoTime}|null} restartRequired set while config.json asks for something that is only read at start (today: any key of `mqtt`). Nothing moves on the wire until the process is restarted.
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
 * @property {Epoch} epoch a client that holds another epoch throws away what it has and starts from this snapshot
 * @property {number} seq position in the live channel of this epoch; events with a lower or equal seq are already included
 * @property {ControllerStatus} controller
 * @property {MqttStatus} mqtt
 * @property {ConfigFileState} config
 * @property {DeviceView[]} devices config order, then blob-only devices
 * @property {SceneMeta[]} scenes
 * @property {Record<DeviceType, BuiltinMode[]>} builtins
 * @property {OverlayRecord[]} overlays
 */

/**
 * Events of the live channel (GET /api/v2/events, server-sent events).
 * `id:` of every event is "<epoch>-<seq>"; `event:` is the type below.
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
