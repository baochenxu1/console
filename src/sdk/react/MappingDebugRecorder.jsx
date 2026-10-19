import { useCallback, useEffect, useState } from "react"
import { exportJsonFile, exportTextFile, getDateTimeText } from "../../utils/fileExport.js"

/** @typedef {import("../tracking/trackingTypes.js").RigFrame} RigFrameLike */

const LS_KEY = "facedev.mappingObservations.v1"

const BLEND_KEYS = [
  "jawOpen",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeWideLeft",
  "eyeWideRight",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPucker",
  "mouthFunnel",
  "mouthClose",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
]

const MAP_KEYS = [
  "jaw",
  "blinkLeft",
  "blinkRight",
  "smileLeft",
  "smileRight",
  "browLeft",
  "browRight",
  "eyeOpenBiasLeft",
  "eyeOpenBiasRight",
  "eyeLUp",
  "eyeLLo",
  "eyeRUp",
  "eyeRLo",
  "browInner",
  "browOuterLeft",
  "browOuterRight",
  "browLeftTip",
  "browLeftMid",
  "browLeftTail",
  "browRightTip",
  "browRightMid",
  "browRightTail",
  "upperLipLeft",
  "upperLipRight",
  "lowerLipLeft",
  "lowerLipRight",
  "mouthPucker",
  "mouthFunnel",
]

/** 列表展示用：含 gaze 相关 mapping 键（pickMapping 仍只存 MAP_KEYS） */
const MAP_KEYS_DISPLAY = [...MAP_KEYS, "eyeLookX", "eyeLookY", "sharedRadarX", "sharedRadarY"]

/** CSV 列名：与 blend 同名的 mapping 调试量加后缀，避免表头重复 */
function csvMappingHeader(k) {
  if (k === "mouthPucker" || k === "mouthFunnel") {
    return `${k}Mapping`
  }
  return k
}

function loadObservationsFromStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) {
      return []
    }
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function newObservationId() {
  return `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** 兼容旧版 observation：仅有 rig 时视为 calibratedRig */
export function getObservationCalibratedRig(o) {
  if (!o || typeof o !== "object") {
    return {}
  }
  if (o.calibratedRig != null && typeof o.calibratedRig === "object") {
    return o.calibratedRig
  }
  if (o.rig != null && typeof o.rig === "object") {
    return o.rig
  }
  return {}
}

export function getObservationRawFrameRig(o) {
  if (!o || typeof o !== "object") {
    return {}
  }
  if (o.rawFrameRig != null && typeof o.rawFrameRig === "object") {
    return o.rawFrameRig
  }
  return {}
}

export function getObservationLogicalPose(o) {
  if (!o || typeof o !== "object") {
    return {}
  }
  return o.logicalPose != null && typeof o.logicalPose === "object" ? o.logicalPose : {}
}

/** @param {import("../tracking/trackingTypes.js").RigFrame["debug"] | null | undefined} debug */
function pickBlendshapes(debug) {
  const b =
    debug && typeof debug === "object" && debug.blendshapes && typeof debug.blendshapes === "object"
      ? debug.blendshapes
      : {}
  /** @type {Record<string, number>} */
  const out = {}
  for (const k of BLEND_KEYS) {
    const v = b[k]
    out[k] = Number.isFinite(Number(v)) ? Number(v) : 0
  }
  return out
}

/** @param {import("../tracking/trackingTypes.js").RigFrame["debug"] | null | undefined} debug */
function pickMapping(debug) {
  const m =
    debug && typeof debug === "object" && debug.mapping && typeof debug.mapping === "object"
      ? debug.mapping
      : {}
  /** @type {Record<string, number>} */
  const out = {}
  for (const k of MAP_KEYS) {
    const v = m[k]
    out[k] = Number.isFinite(Number(v)) ? Number(v) : 0
  }
  return out
}

function pickGaze(debug) {
  const g =
    debug && typeof debug === "object" && debug.gaze && typeof debug.gaze === "object" ? debug.gaze : null
  if (!g) {
    return null
  }
  return {
    available: Boolean(g.available),
    eyeLookX: Number.isFinite(Number(g.eyeLookX)) ? Number(g.eyeLookX) : 0,
    eyeLookY: Number.isFinite(Number(g.eyeLookY)) ? Number(g.eyeLookY) : 0,
    leftEyeX: Number.isFinite(Number(g.leftEyeX)) ? Number(g.leftEyeX) : 0,
    leftEyeY: Number.isFinite(Number(g.leftEyeY)) ? Number(g.leftEyeY) : 0,
    rightEyeX: Number.isFinite(Number(g.rightEyeX)) ? Number(g.rightEyeX) : 0,
    rightEyeY: Number.isFinite(Number(g.rightEyeY)) ? Number(g.rightEyeY) : 0,
  }
}

function observationsFilenameStem() {
  const stamp = getDateTimeText()
  const parts = stamp.split("_")
  if (parts.length === 2) {
    return `${parts[0]}-${parts[1]}`
  }
  return stamp
}

function escapeCsvField(value) {
  const s = String(value ?? "")
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function cloneJsonObject(obj) {
  try {
    return structuredClone(obj && typeof obj === "object" ? obj : {})
  } catch {
    return JSON.parse(JSON.stringify(obj ?? {}))
  }
}

/**
 * @param {object} props
 * @param {RigFrameLike | null | undefined} props.lastFrame — UI 降频展示用（如 displayTrackingFrame）
 * @param {(() => RigFrameLike | null | undefined) | undefined} props.getLastTrackingFrame — 记录时取最新一帧（避免与降频展示错位）
 * @param {object} props.currentRig — 前端当前面控 rig（开启 Drive Rig 时为校准/平滑后的 rig）
 * @param {object} props.logicalPose
 */
export default function MappingDebugRecorder({ lastFrame, getLastTrackingFrame, currentRig, logicalPose }) {
  const [observations, setObservations] = useState(loadObservationsFromStorage)
  const [actionName, setActionName] = useState("")
  const [expectedMotion, setExpectedMotion] = useState("")

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(observations))
    } catch {
      //
    }
  }, [observations])

  const recordCurrent = useCallback(() => {
    const lf =
      typeof getLastTrackingFrame === "function"
        ? getLastTrackingFrame() ?? lastFrame
        : lastFrame
    const debug = lf && typeof lf === "object" ? lf.debug : undefined
    const blendshapes = pickBlendshapes(debug)
    const mapping = pickMapping(debug)
    const gazeSnap = pickGaze(debug)
    const source =
      lf && typeof lf === "object" && typeof lf.source === "string" ? lf.source : "none"
    const faceDetected = Boolean(lf?.faceDetected)
    const quality = Number.isFinite(Number(lf?.quality)) ? Number(lf.quality) : 0

    const rawFrameRig =
      lf && typeof lf === "object" && lf.rig && typeof lf.rig === "object"
        ? cloneJsonObject(lf.rig)
        : {}
    const calibratedRig = cloneJsonObject(currentRig && typeof currentRig === "object" ? currentRig : {})
    const poseSnap = cloneJsonObject(logicalPose && typeof logicalPose === "object" ? logicalPose : {})

    const obs = {
      id: newObservationId(),
      createdAt: new Date().toISOString(),
      actionName: String(actionName ?? "").trim() || "(未命名)",
      expectedMotion: String(expectedMotion ?? "").trim(),
      source,
      faceDetected,
      quality,
      blendshapes,
      mapping,
      gaze: gazeSnap ? cloneJsonObject(gazeSnap) : null,
      rawFrameRig,
      calibratedRig,
      logicalPose: poseSnap,
    }

    setObservations((prev) => [obs, ...prev])
  }, [getLastTrackingFrame, lastFrame, currentRig, logicalPose, actionName, expectedMotion])

  const clearAll = useCallback(() => {
    setObservations([])
    try {
      localStorage.removeItem(LS_KEY)
    } catch {
      //
    }
  }, [])

  const exportJson = useCallback(() => {
    const stem = observationsFilenameStem()
    exportJsonFile(`facedev-mapping-observations-${stem}.json`, {
      exportedAt: new Date().toISOString(),
      observations,
    })
  }, [observations])

  const exportCsv = useCallback(() => {
    const headers = [
      "createdAt",
      "actionName",
      "expectedMotion",
      "source",
      "faceDetected",
      "quality",
      ...BLEND_KEYS,
      "mappingJaw",
      "mappingBlinkLeft",
      "mappingBlinkRight",
      "mappingSmileLeft",
      "mappingSmileRight",
      "mappingBrowLeft",
      "mappingBrowRight",
      ...MAP_KEYS.filter((k) => !["jaw", "blinkLeft", "blinkRight", "smileLeft", "smileRight", "browLeft", "browRight"].includes(k)).map(
        (k) => csvMappingHeader(k),
      ),
      "gazeAvailable",
      "eyeLookX",
      "eyeLookY",
      "sharedRadarX",
      "sharedRadarY",
      "rawFrameRigJson",
      "calibratedRigJson",
      "logicalPoseJson",
      "rigJson",
    ]

    const lines = [headers.join(",")]
    for (const o of observations) {
      const rawFrameRig = getObservationRawFrameRig(o)
      const calibratedRig = getObservationCalibratedRig(o)
      const logicalPoseObj = getObservationLogicalPose(o)
      const rawFrameRigJson = JSON.stringify(rawFrameRig)
      const calibratedRigJson = JSON.stringify(calibratedRig)
      const logicalPoseJson = JSON.stringify(logicalPoseObj)
      /** @deprecated 与旧列名兼容，语义同 calibratedRigJson */
      const rigJsonDeprecated = calibratedRigJson

      const extraMapKeys = MAP_KEYS.filter(
        (k) => !["jaw", "blinkLeft", "blinkRight", "smileLeft", "smileRight", "browLeft", "browRight"].includes(k),
      )

      const row = [
        o.createdAt,
        o.actionName,
        o.expectedMotion,
        o.source,
        o.faceDetected ? "true" : "false",
        o.quality,
        ...BLEND_KEYS.map((k) => (o.blendshapes && o.blendshapes[k] !== undefined ? o.blendshapes[k] : "")),
        o.mapping?.jaw ?? "",
        o.mapping?.blinkLeft ?? "",
        o.mapping?.blinkRight ?? "",
        o.mapping?.smileLeft ?? "",
        o.mapping?.smileRight ?? "",
        o.mapping?.browLeft ?? "",
        o.mapping?.browRight ?? "",
        ...extraMapKeys.map((k) =>
          o.mapping && Number.isFinite(Number(o.mapping[k])) ? o.mapping[k] : "",
        ),
        o.gaze && o.gaze.available === true ? "true" : "false",
        o.gaze && Number.isFinite(Number(o.gaze.eyeLookX)) ? o.gaze.eyeLookX : "",
        o.gaze && Number.isFinite(Number(o.gaze.eyeLookY)) ? o.gaze.eyeLookY : "",
        o.mapping && Number.isFinite(Number(o.mapping.sharedRadarX)) ? o.mapping.sharedRadarX : "",
        o.mapping && Number.isFinite(Number(o.mapping.sharedRadarY)) ? o.mapping.sharedRadarY : "",
        rawFrameRigJson,
        calibratedRigJson,
        logicalPoseJson,
        rigJsonDeprecated,
      ].map(escapeCsvField)
      lines.push(row.join(","))
    }

    const stem = observationsFilenameStem()
    const bom = "\uFEFF"
    exportTextFile(
      `facedev-mapping-observations-${stem}.csv`,
      bom + lines.join("\n"),
      "text/csv;charset=utf-8"
    )
  }, [observations])

  const fmtTime = useCallback((iso) => {
    try {
      return new Date(iso).toLocaleString(undefined, { hour12: false })
    } catch {
      return String(iso ?? "")
    }
  }, [])

  const fmtBlendLine = useCallback((b) => {
    if (!b || typeof b !== "object") {
      return "—"
    }
    return BLEND_KEYS.map((k) => `${k}:${Number.isFinite(Number(b[k])) ? Number(b[k]).toFixed(2) : "—"}`).join(
      " · "
    )
  }, [])

  const fmtMapLine = useCallback((m) => {
    if (!m || typeof m !== "object") {
      return "—"
    }
    const fmtVal = (v) => {
      if (!Number.isFinite(Number(v))) {
        return "—"
      }
      return Number(v).toFixed(2)
    }
    return MAP_KEYS_DISPLAY.map((k) => `${k}:${fmtVal(m[k])}`).join(" · ")
  }, [])

  return (
    <details className="sdk-mapping-debug-recorder">
      <summary className="sdk-mapping-debug-recorder-summary">Mapping Debug Recorder</summary>
      <div className="sdk-mapping-debug-recorder-body">
        <div className="sdk-mapping-debug-recorder-fields">
          <label className="sdk-mapping-debug-recorder-label">
            <span>当前动作名称</span>
            <input
              type="text"
              className="sdk-mapping-debug-recorder-input"
              value={actionName}
              onChange={(e) => setActionName(e.target.value)}
              placeholder="例如：张嘴"
              spellCheck={false}
            />
          </label>
          <label className="sdk-mapping-debug-recorder-label">
            <span>预期说明（控件 / 舵机方向备注）</span>
            <textarea
              className="sdk-mapping-debug-recorder-textarea"
              value={expectedMotion}
              onChange={(e) => setExpectedMotion(e.target.value)}
              placeholder="例如：下巴控件向下、实体舵机顺时针"
              rows={2}
              spellCheck={false}
            />
          </label>
        </div>
        <div className="sdk-mapping-debug-recorder-actions">
          <button type="button" className="btn-secondary btn-tiny" onClick={recordCurrent}>
            记录当前帧
          </button>
          <button type="button" className="btn-secondary btn-tiny" onClick={clearAll}>
            清空记录
          </button>
          <button type="button" className="btn-secondary btn-tiny" onClick={exportJson} disabled={!observations.length}>
            导出 JSON
          </button>
          <button type="button" className="btn-secondary btn-tiny" onClick={exportCsv} disabled={!observations.length}>
            导出 CSV
          </button>
        </div>
        <p className="hint sdk-mapping-debug-recorder-hint">
          仅观察与导出；不改变 Drive Rig、串口与关键帧逻辑。每条记录含 WebSocket 原始 <code>rawFrameRig</code> 与
          编辑器当前 <code>calibratedRig</code>。本地存储键：<code>{LS_KEY}</code>
        </p>
        <div className="sdk-mapping-debug-recorder-list-wrap">
          <div className="sdk-mapping-debug-recorder-list-title">记录列表（{observations.length}）</div>
          {observations.length === 0 ? (
            <p className="hint">
              尚无记录。开启 Tracking 后点击「记录当前帧」可保存 blendshapes / mapping / rawFrameRig /
              calibratedRig / logicalPose。
            </p>
          ) : (
            <ul className="sdk-mapping-debug-recorder-list">
              {observations.map((o) => {
                const rawR = getObservationRawFrameRig(o)
                const calR = getObservationCalibratedRig(o)
                const pose = getObservationLogicalPose(o)
                return (
                  <li key={o.id} className="sdk-mapping-debug-recorder-item">
                    <div className="sdk-mapping-debug-recorder-item-head">
                      <strong>{o.actionName}</strong>
                      <span className="sdk-mapping-debug-recorder-item-time" title={o.createdAt}>
                        {fmtTime(o.createdAt)}
                      </span>
                    </div>
                    {o.expectedMotion ? (
                      <div className="sdk-mapping-debug-recorder-item-expected">预期：{o.expectedMotion}</div>
                    ) : null}
                    <div className="sdk-mapping-debug-recorder-item-meta">
                      source: {o.source} · face: {o.faceDetected ? "yes" : "no"} · quality:{" "}
                      {Number.isFinite(o.quality) ? o.quality.toFixed(2) : o.quality}
                    </div>
                    <div className="sdk-mapping-debug-recorder-item-block">
                      <span className="sdk-mapping-debug-recorder-k">blendshapes</span>
                      <code className="sdk-mapping-debug-recorder-code">{fmtBlendLine(o.blendshapes)}</code>
                    </div>
                    <div className="sdk-mapping-debug-recorder-item-block">
                      <span className="sdk-mapping-debug-recorder-k">mapping</span>
                      <code className="sdk-mapping-debug-recorder-code">{fmtMapLine(o.mapping)}</code>
                    </div>
                    <details className="sdk-mapping-debug-recorder-nested">
                      <summary>Raw Frame Rig（WebSocket 原始 rig）</summary>
                      <pre className="sdk-mapping-debug-recorder-pre">{JSON.stringify(rawR, null, 2)}</pre>
                    </details>
                    <details className="sdk-mapping-debug-recorder-nested">
                      <summary>Calibrated Rig（前端当前 rig）</summary>
                      <pre className="sdk-mapping-debug-recorder-pre">{JSON.stringify(calR, null, 2)}</pre>
                    </details>
                    <details className="sdk-mapping-debug-recorder-nested">
                      <summary>Logical Pose（绑定输出）</summary>
                      <pre className="sdk-mapping-debug-recorder-pre">{JSON.stringify(pose, null, 2)}</pre>
                    </details>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </details>
  )
}
