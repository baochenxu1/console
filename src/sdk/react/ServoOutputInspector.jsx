import { useMemo, useRef, useState } from "react"
import {
  buildBindingOutputDiagnostics,
  buildControlChannelSweepDiagnostics,
  listProfileControlChannels,
} from "../binding/bindingDiagnostics.js"
import { createInitialEliteRig, buildServoMovesFromLogicalPose } from "../../core/faceDofMapper.js"
import { buildFinalServoOutputsFromBindings } from "../output/buildFinalServoOutputsFromBindings.js"
import { enrichFinalServoOutputsForPreview } from "../output/enrichFinalServoOutputs.js"
import { loadActuatorProfiles } from "../output/loadActuatorProfiles.js"

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) {
    return "—"
  }
  return Number(v).toFixed(2)
}

function fmtInt(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) {
    return "—"
  }
  return String(Math.round(Number(v)))
}

function dirZh(d) {
  if (d === "positive") {
    return "正向"
  }
  if (d === "negative") {
    return "负向"
  }
  return "中性"
}

function pctRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return "—"
  }
  return `${Math.round(ratio * 100)}%`
}

function BrowFiveBarKinematicsSection({
  sideLabel,
  nodeHint,
  defaultFKey,
  defaultDKey,
  k,
  logicalPose,
  showSync = false,
  sync = null,
}) {
  const title = `运动学 · ${sideLabel} Brow FiveBar`
  if (!k) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">{title}</h4>
        <p className="sdk-servo-inspector-hint">无{sideLabel === "Right" ? "右" : "左"}眉五杆诊断数据。</p>
      </>
    )
  }
  if (k.enabled === false) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">{title}</h4>
        <p className="sdk-servo-inspector-hint">{sideLabel === "Right" ? "右" : "左"}眉五杆未启用。</p>
      </>
    )
  }
  if (k.readyForIk === false) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">{title}</h4>
        <p className="sdk-servo-inspector-hint">
          已启用但未就绪：{k.ikMessage || `请检查 ${defaultFKey} / ${defaultDKey} 绑定`}
        </p>
      </>
    )
  }
  const lin = k.lineage || {}
  const s = sync || k.sync || null
  const fmtPt = (p) =>
    p && Array.isArray(p) && p.length >= 2 ? `[${fmt(p[0])}, ${fmt(p[1])}]` : "—"
  const readLp = (sid) => {
    if (!logicalPose || sid == null) return null
    const v = logicalPose[String(sid)]
    return v != null && typeof v === "object" ? v.logicalPwm : v
  }
  const servoF = lin.F?.servoId ?? k.servoFId
  const servoD = lin.D?.servoId ?? k.servoDId
  return (
    <>
      <h4 className="sdk-servo-inspector-subtitle">
        {title}（{nodeHint}）
      </h4>
      <ul className="sdk-servo-inspector-list sdk-servo-inspector-list--config">
        <li>
          brow.x / y: {fmt(lin.brow?.x ?? k.brow?.x ?? k.browTarget?.x)} /{" "}
          {fmt(lin.brow?.y ?? k.brow?.y ?? k.browTarget?.y)}
        </li>
        <li>targetA: {fmtPt(lin.targetA || k.Asafe || k.Aworld)}</li>
        <li>
          alphaF / alphaD（°）: {fmt(lin.alphaF ?? k.alphaF ?? k.thetaFDeg)} /{" "}
          {fmt(lin.alphaD ?? k.alphaD ?? k.thetaDDeg)}
        </li>
        <li>
          qF / qD IK（°）: {fmt(lin.qF ?? k.qFDeg ?? k.tipB_deg)} / {fmt(lin.qD ?? k.qDDeg ?? k.tipA_deg)}
        </li>
        <li>
          qF / qD cmd（°）: {fmt(k.qFCommandDeg)} / {fmt(k.qDCommandDeg)}
        </li>
        <li>
          F binding / servo: {lin.F?.bindingKey || k.nodeFBindingKey || defaultFKey} → ID
          {fmtInt(servoF)}
        </li>
        <li>
          D binding / servo: {lin.D?.bindingKey || k.nodeDBindingKey || defaultDKey} → ID
          {fmtInt(servoD)}
        </li>
        <li>
          final cmd F / D: {fmtInt(k.finalCommandF ?? readLp(servoF))} /{" "}
          {fmtInt(k.finalCommandD ?? readLp(servoD))}
        </li>
        <li>
          logicalPwm F / D: {fmtInt(lin.F?.logicalPwm ?? k.logicalPwmF ?? k.pwmF)} /{" "}
          {fmtInt(lin.D?.logicalPwm ?? k.logicalPwmD ?? k.pwmD)}
        </li>
        {(k.fdWarnings || []).map((w) => (
          <li key={w}>⚠ {w}</li>
        ))}
      </ul>
      {showSync ? (
        <>
          <h4 className="sdk-servo-inspector-subtitle">{sideLabel} Brow FiveBar Sync</h4>
          {!s || s.enabled === false ? (
            <p className="sdk-servo-inspector-hint">无同步 Group 诊断（未接入 Host trajectory）。</p>
          ) : (
            <ul className="sdk-servo-inspector-list sdk-servo-inspector-list--config">
              <li>mode / space: {s.mode || "—"} / {s.space || "—"}</li>
              <li>
                desiredA x/y: {fmt(s.desiredA?.x)} / {fmt(s.desiredA?.y)}
              </li>
              <li>
                commandedA x/y: {fmt(s.commandedA?.x ?? s.nextA?.x)} /{" "}
                {fmt(s.commandedA?.y ?? s.nextA?.y)}
              </li>
              <li>AErrorMm: {fmt(s.aErrorMm)}</li>
              <li>
                velocityA x/y: {fmt(s.velocityA?.x)} / {fmt(s.velocityA?.y)}
              </li>
              <li>
                lastSuccessfullySentA: {fmt(s.lastSuccessfullySentA?.x)} /{" "}
                {fmt(s.lastSuccessfullySentA?.y)}
              </li>
              <li>
                latestTargetSeq / ageMs: {fmtInt(s.latestTargetSeq)} / {fmtInt(s.latestTargetAgeMs)}
              </li>
              <li>
                maxServoHz / actualSendHz: {fmt(s.maxServoHz)} / {fmt(s.actualSendHz ?? s.actualTickHz)}
              </li>
              <li>
                send P50 / P95 / maxIntervalMs: {fmt(s.sendIntervalP50 ?? s.tickIntervalP50)} /{" "}
                {fmt(s.sendIntervalP95 ?? s.tickIntervalP95)} / {fmt(s.maxSendIntervalMs)}
              </li>
              <li>actualDtMs: {fmt(s.actualDtMs)}</li>
              <li>
                qF / qD: {fmt(s.qF ?? s.nextF)} / {fmt(s.qD ?? s.nextD)}
              </li>
              <li>
                pairSeq / groupSeq: {fmtInt(s.pairSeq)} / {fmtInt(s.groupSeq)}
              </li>
              <li>
                syncWrite / durationMs: {String(s.syncWrite)} / {fmt(s.syncWriteDurationMs)}
              </li>
              <li>
                ID1 / ID2: {fmtInt(s.ID1)} / {fmtInt(s.ID2)}
              </li>
              <li>
                servoInternal time / speed: {fmtInt(s.servoInternalTime)} /{" "}
                {fmtInt(s.servoInternalSpeed)}
              </li>
              <li>sharedStep / progress: {fmt(s.sharedStep)} / {fmt(s.sharedProgress)}</li>
              <li>finalSettleActive: {String(s.finalSettleActive)}</li>
              <li>
                target pad x/y: {fmt(s.targetX)} / {fmt(s.targetY)}
              </li>
              <li>batchSendCount: {fmtInt(s.batchSendCount)}</li>
              <li>groupFinished: {String(s.groupFinished)}</li>
              <li>replan: {s.lastReplanReason || "—"}</li>
              {s.lastRejectReason ? <li>⚠ reject: {s.lastRejectReason}</li> : null}
            </ul>
          )}
        </>
      ) : null}
    </>
  )
}

function RightBrowFiveBarKinematicsSection({ k, sync, logicalPose }) {
  return (
    <BrowFiveBarKinematicsSection
      sideLabel="Right"
      nodeHint="F→ID1 / D→ID2"
      defaultFKey="brow_r_F"
      defaultDKey="brow_r_D"
      k={k}
      sync={sync}
      logicalPose={logicalPose}
      showSync
    />
  )
}

function LeftBrowFiveBarKinematicsSection({ k, sync, logicalPose }) {
  return (
    <BrowFiveBarKinematicsSection
      sideLabel="Left"
      nodeHint="F→ID24 / D→ID23"
      defaultFKey="brow_l_F"
      defaultDKey="brow_l_D"
      k={k}
      sync={sync}
      logicalPose={logicalPose}
      showSync
    />
  )
}

function Jaw3dKinematicsSection({ k, logicalPose }) {
  if (!k) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">运动学 · Jaw 3D</h4>
        <p className="sdk-servo-inspector-hint">无下颌 3D 诊断数据。</p>
      </>
    )
  }
  if (k.enabled === false) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">运动学 · Jaw 3D</h4>
        <p className="sdk-servo-inspector-hint">Jaw 3D IK 未启用。</p>
      </>
    )
  }
  if (k.readyForIk === false) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">运动学 · Jaw 3D</h4>
        <p className="sdk-servo-inspector-hint">已启用但未就绪：{k.ikMessage || "检查 jaw_A / jaw_D 绑定"}</p>
      </>
    )
  }
  const fmtPt = (p) =>
    p && Array.isArray(p) && p.length >= 3
      ? `[${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])}]`
      : "—"
  const bind = k.binding || {}
  const geo = k.geometry || {}
  const cons = k.constraints || {}
  const inp = k.input || {}
  return (
    <>
      <h4 className="sdk-servo-inspector-subtitle">运动学 · Jaw 3D（A/D 节点）</h4>
      <ul className="sdk-servo-inspector-list sdk-servo-inspector-list--config">
        <li>
          jaw.value / lateral: {fmt(inp.value)} / {fmt(inp.lateral)}
        </li>
        <li>
          qA / qD（°）: {fmt(k.servo?.qA ?? k.qACommandDeg)} / {fmt(k.servo?.qD ?? k.qDCommandDeg)}
        </li>
        <li>
          betaA / betaD（°）: {fmt(geo.betaA)} / {fmt(geo.betaD)}
        </li>
        <li>M: {fmtPt(geo.M)}</li>
        <li>
          A binding / servo: {bind.nodeAKey || "jaw_A"} → ID{fmtInt(bind.servoAId)}
        </li>
        <li>
          D binding / servo: {bind.nodeDKey || "jaw_D"} → ID{fmtInt(bind.servoDId)}
        </li>
        <li>
          final cmd A / D: {fmtInt(k.finalCommandA)} / {fmtInt(k.finalCommandD)}
        </li>
        <li>
          residuals AB/DE/BC/EF/CF/OM: {fmt(cons.errAB)} / {fmt(cons.errDE)} / {fmt(cons.errBC)} /{" "}
          {fmt(cons.errEF)} / {fmt(cons.errCF)} / {fmt(cons.errOM)}
        </li>
        <li>
          branch / limit: {cons.branch || "—"} / {cons.limitReason || "—"}
        </li>
        {k.ikOk === false ? <li>⚠ {k.ikMessage || "IK 失败"}</li> : null}
      </ul>
    </>
  )
}

function MouthFiveBarKinematicsSection({ title, k, controlId, configs, logicalPose }) {
  if (!k) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">{title}</h4>
        <p className="sdk-servo-inspector-hint">无运动学诊断数据。</p>
      </>
    )
  }
  if (k.enabled === false) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">{title}</h4>
        <p className="sdk-servo-inspector-hint">五杆 IK 未启用。</p>
      </>
    )
  }
  if (k.readyForIk === false) {
    return (
      <>
        <h4 className="sdk-servo-inspector-subtitle">{title}</h4>
        <p className="sdk-servo-inspector-hint">
          已启用但未就绪：{k.ikMessage || `请检查 ${controlId}.x / y 绑定`}
        </p>
      </>
    )
  }
  const fmtPt = (p) =>
    p && Array.isArray(p) && p.length >= 2 ? `[${fmt(p[0])}, ${fmt(p[1])}]` : "—"
  const ok = k.ok !== false && k.ikOk !== false
  const movesForCmd =
    configs.length > 0 && logicalPose && typeof logicalPose === "object"
      ? buildServoMovesFromLogicalPose(logicalPose, configs, 50)
      : []
  const moveIds = new Set(movesForCmd.map((m) => m.servoId))
  const sidA = Number(k.servoAId)
  const sidB = Number(k.servoBId)
  const cmdIncludesAB =
    Number.isFinite(sidA) && Number.isFinite(sidB) && moveIds.has(sidA) && moveIds.has(sidB)
  const padLabel = controlId === "mouth_corner_l" ? "sideL" : "sideR"
  return (
    <>
      <h4 className="sdk-servo-inspector-subtitle">{title}</h4>
      <ul className="sdk-servo-inspector-list sdk-servo-inspector-list--config">
        <li className="sdk-servo-inspector-sublist-title">{title} Runtime</li>
        <li>source: {k.source ?? "—"}</li>
        <li>runtimeSource: {k.runtimeSource ?? "—"}</li>
        <li>
          {padLabel}.x / y: {fmt(k.sideR?.x ?? k.padRaw?.x)} / {fmt(k.sideR?.y ?? k.padRaw?.y)}
        </li>
        <li>
          rawPad X / Y: {fmt(k.rawPadX)} / {fmt(k.rawPadY)}
        </li>
        <li>
          effectivePad X / Y: {fmt(k.effectivePadX)} / {fmt(k.effectivePadY)}
        </li>
        <li>
          flipPad X / Y: {String(k.flipPadX ?? k.effectiveFlipPadX ?? "—")} /{" "}
          {String(k.flipPadY ?? k.effectiveFlipPadY ?? "—")}
        </li>
        <li>
          u / v: {fmt(k.u)} / {fmt(k.v)}
        </li>
        <li>qSend A / B（°）: {fmt(k.qSend?.qA_deg ?? k.qRaw?.qA_deg)} / {fmt(k.qSend?.qB_deg ?? k.qRaw?.qB_deg)}</li>
        <li>
          Lab neutral A / B: {fmtInt(k.effectiveNeutralPwmA)} / {fmtInt(k.effectiveNeutralPwmB)}
        </li>
        <li>
          binding neutral A / B: {fmtInt(k.bindingNeutralPwmA)} / {fmtInt(k.bindingNeutralPwmB)}
        </li>
        <li>
          logicalPwm A / B: {fmtInt(k.logicalPwmA ?? k.pwmA)} / {fmtInt(k.logicalPwmB ?? k.pwmB)}
        </li>
        <li>
          actualPwm A / B: {fmtInt(k.actualPwmA)} / {fmtInt(k.actualPwmB)}
        </li>
        <li>scale: {fmt(k.scale)}</li>
        <li>
          effective Kx / Ky: {fmt(k.effectiveKx)} / {fmt(k.effectiveKy)}
        </li>
        <li>
          effective xSign / ySign: {fmt(k.effectiveXSign)} / {fmt(k.effectiveYSign)}
        </li>
        <li>outputMode: {String(k.runtimeOutputMode ?? k.outputMode ?? "—")}</li>
        <li>command includes A/B: {configs.length ? (cmdIncludesAB ? "yes" : "no") : "—（无 configs）"}</li>
        <li className="sdk-servo-inspector-sublist-title">运动学细节</li>
        <li>ok: {String(ok)}</li>
        <li>D0: {fmtPt(k.D0)}</li>
        <li>D_raw: {fmtPt(k.D_raw)}</li>
        <li>D_safe: {fmtPt(k.D_safe)}</li>
        <li>
          qRawA / qRawB（°）: {fmt(k.qRawA ?? k.qRaw?.qA_deg)} / {fmt(k.qRawB ?? k.qRaw?.qB_deg)}
        </li>
        <li>
          qCmdA / qCmdB（°）: {fmt(k.qCmdA ?? k.qCmd?.qA_deg ?? k.qA_deg)} /{" "}
          {fmt(k.qCmdB ?? k.qCmd?.qB_deg ?? k.qB_deg)}
        </li>
        <li>servoA / B: {fmtInt(k.servoAId)} / {fmtInt(k.servoBId)}</li>
        {Number.isFinite(Number(k.servoAId)) &&
        Number.isFinite(Number(k.servoBId)) &&
        Number(k.servoAId) === Number(k.servoBId) ? (
          <li className="sdk-servo-inspector-err">
            warning：五杆 X/Y 指向同一舵机 {fmtInt(k.servoAId)}，请检查 Runtime Baseline 或 profile 绑定。
          </li>
        ) : null}
        <li>
          IK: {ok ? "ok" : "失败"}
          {k.ikMessage ? ` — ${k.ikMessage}` : ""}
        </li>
        {k.message ? <li>message: {k.message}</li> : null}
        {k.overrideNote ? <li>{k.overrideNote}</li> : null}
        {!ok && k.enabled ? (
          <li className="sdk-servo-inspector-err">
            warning：IK 无解或未通过关节限位，本帧仍使用 {controlId} 线性绑定合成结果。
          </li>
        ) : null}
      </ul>
    </>
  )
}

function rowMotionClass(r) {
  if (!r.enabled) {
    return "sdk-servo-inspector-row--off"
  }
  const parts = [`sdk-servo-inspector-ml-${r.motionLevel || "neutral"}`]
  if (r.clipped) {
    parts.push("sdk-servo-inspector-row--clip")
  }
  if (r.hasCurrentIssue) {
    parts.push("sdk-servo-inspector-row--current")
  }
  return parts.join(" ")
}

/**
 * Face Rig → 舵机 PWM 只读诊断（不触发 WebSerial）。
 *
 * @param {object} props
 * @param {object} props.profile
 * @param {object} props.rig rawFrameRig / calibratedRig（elite 结构）
 * @param {object} [props.logicalPose] 预留
 * @param {object[]} [props.configs]
 * @param {object} [props.precomputedDiagnostics] 若传入则跳过内部 build（与父组件共用同一诊断实例）
 */
export default function ServoOutputInspector({
  profile,
  rig,
  logicalPose = undefined,
  configs = [],
  precomputedDiagnostics = undefined,
  /** 拖动中跳过重诊断，避免卡顿 */
  suspendHeavy = false,
}) {
  const rigSafe = rig && typeof rig === "object" ? rig : createInitialEliteRig()
  const lastDiagRef = useRef(null)
  const diag = useMemo(() => {
    if (precomputedDiagnostics) {
      lastDiagRef.current = precomputedDiagnostics
      return precomputedDiagnostics
    }
    if (suspendHeavy && lastDiagRef.current) {
      return lastDiagRef.current
    }
    const next = buildBindingOutputDiagnostics({
      profile,
      rig: rigSafe,
      logicalPose,
      configs,
    })
    lastDiagRef.current = next
    return next
  }, [precomputedDiagnostics, profile, rigSafe, logicalPose, configs, suspendHeavy])

  const channelOptions = useMemo(() => listProfileControlChannels(profile), [profile])
  const [sweepKey, setSweepKey] = useState(() => {
    const d = channelOptions.find((o) => o.controlId === "mouth_corner_l" && o.channel === "x")
    return d ? `${d.controlId}\t${d.channel}` : channelOptions[0] ? `${channelOptions[0].controlId}\t${channelOptions[0].channel}` : ""
  })

  const sweepParsed = useMemo(() => {
    if (!sweepKey || !sweepKey.includes("\t")) {
      return { controlId: "", channel: "" }
    }
    const [controlId, channel] = sweepKey.split("\t")
    return { controlId, channel }
  }, [sweepKey])

  const sweep = useMemo(() => {
    if (suspendHeavy) {
      return { steps: [], mode: "", error: "", suspended: true }
    }
    if (!sweepParsed.controlId) {
      return { steps: [], mode: "", error: "无可用控件通道" }
    }
    return buildControlChannelSweepDiagnostics({
      profile,
      configs,
      controlId: sweepParsed.controlId,
      channel: sweepParsed.channel,
    })
  }, [profile, configs, sweepParsed.controlId, sweepParsed.channel, suspendHeavy])

  const [sortBy, setSortBy] = useState("servoId")
  const [sortAsc, setSortAsc] = useState(true)
  const [onlyActive, setOnlyActive] = useState(false)
  const [onlyWarnings, setOnlyWarnings] = useState(false)
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [onlyCurrentIssues, setOnlyCurrentIssues] = useState(false)
  const [onlyConfigRisks, setOnlyConfigRisks] = useState(false)
  const [onlyEffectiveMotion, setOnlyEffectiveMotion] = useState(false)
  const [onlyMediumStrong, setOnlyMediumStrong] = useState(false)
  const [onlyDuplicateServo, setOnlyDuplicateServo] = useState(false)
  const [configRisksExpanded, setConfigRisksExpanded] = useState(false)

  const sortedRows = useMemo(() => {
    let list = [...(diag?.rows || [])]
    if (onlyActive) {
      list = list.filter((r) => r.enabled)
    }
    if (onlyWarnings) {
      list = list.filter(
        (r) =>
          r.hasCurrentIssue ||
          r.smallMotionWarning ||
          r.duplicateServoWarning ||
          r.clipped
      )
    }
    if (onlyChanged) {
      list = list.filter(
        (r) => r.deltaFromNeutral !== null && Math.abs(r.deltaFromNeutral) >= 1
      )
    }
    if (onlyCurrentIssues) {
      list = list.filter((r) => r.hasCurrentIssue)
    }
    if (onlyConfigRisks) {
      list = list.filter((r) => r.hasConfigRisk)
    }
    if (onlyEffectiveMotion) {
      list = list.filter((r) => r.motionLevel && r.motionLevel !== "neutral")
    }
    if (onlyMediumStrong) {
      list = list.filter((r) => r.motionLevel === "medium" || r.motionLevel === "strong")
    }
    if (onlyDuplicateServo) {
      list = list.filter((r) => r.duplicateServoWarning)
    }
    const mul = sortAsc ? 1 : -1
    list.sort((a, b) => {
      if (sortBy === "servoId") {
        const d = a.servoId - b.servoId
        if (d !== 0) {
          return d * mul
        }
        return `${a.controlId}.${a.channel}`.localeCompare(`${b.controlId}.${b.channel}`) * mul
      }
      const ca = `${a.controlId}.${a.channel}`
      const cb = `${b.controlId}.${b.channel}`
      const d = ca.localeCompare(cb)
      if (d !== 0) {
        return d * mul
      }
      return (a.servoId - b.servoId) * mul
    })
    return list
  }, [
    diag.rows,
    onlyActive,
    onlyWarnings,
    onlyChanged,
    onlyCurrentIssues,
    onlyConfigRisks,
    onlyEffectiveMotion,
    onlyMediumStrong,
    onlyDuplicateServo,
    sortBy,
    sortAsc,
  ])

  const motionStrongMedium = useMemo(
    () => (diag.motionSummary || []).filter((m) => m.motionLevel === "medium" || m.motionLevel === "strong"),
    [diag.motionSummary]
  )

  const servoRowsSorted = useMemo(() => {
    const vals = Object.values(diag.servoOutputCurrent || {})
    return vals.sort((a, b) => a.servoId - b.servoId)
  }, [diag.servoOutputCurrent])

  const actuatorProfiles = useMemo(() => loadActuatorProfiles().actuatorProfiles, [])

  const finalServoOutputs = useMemo(
    () =>
      buildFinalServoOutputsFromBindings({
        profile,
        rig: rigSafe,
        configs,
        sourceType: "manual",
      }),
    [profile, rigSafe, configs]
  )

  const actuatorOutputRows = useMemo(
    () => enrichFinalServoOutputsForPreview(finalServoOutputs, actuatorProfiles),
    [finalServoOutputs, actuatorProfiles]
  )

  const sweepServoIds = useMemo(() => {
    const s = new Set()
    for (const st of sweep.steps || []) {
      for (const k of Object.keys(st.actualPose || {})) {
        s.add(Number(k))
      }
    }
    return [...s].sort((a, b) => a - b)
  }, [sweep.steps])

  const configRisksVisible = configRisksExpanded
    ? diag.configRisks
    : (diag.configRisks || []).slice(0, 5)
  const configRisksHiddenCount = Math.max(0, (diag.configRisks?.length || 0) - 5)

  return (
    <div className="sdk-servo-inspector">
      <p className="sdk-servo-inspector-intro">
        判断顺序：先看 raw/norm 是否有输出，再看 Δ 是否足够大。如果 raw 大但 Δ 小，多半是绑定行程问题；如果 Δ
        大但实体不动，多半是 servoId、机械方向或硬件问题。
      </p>

      <div className="sdk-servo-inspector-block sdk-servo-inspector-block--kinematics">
        <RightBrowFiveBarKinematicsSection
          k={diag.kinematics?.rightBrowFivebar || diag.kinematics?.rightBrowTipFivebar}
          sync={diag.kinematics?.rightBrowFivebarSync}
          logicalPose={diag.logicalPose}
        />
        <LeftBrowFiveBarKinematicsSection
          k={diag.kinematics?.leftBrowFivebar || diag.kinematics?.leftBrowTipFivebar}
          sync={diag.kinematics?.leftBrowFivebarSync}
          logicalPose={diag.logicalPose}
        />
        <Jaw3dKinematicsSection k={diag.kinematics?.jaw3d} logicalPose={diag.logicalPose} />
        <MouthFiveBarKinematicsSection
          title="运动学 · Right Mouth FiveBar"
          k={diag.kinematics?.rightMouthFiveBar || diag.kinematics?.rightMouthCorner || diag.kinematics?.rightMouthCornerFivebar}
          controlId="mouth_corner_r"
          configs={configs}
          logicalPose={diag.logicalPose}
        />
        <MouthFiveBarKinematicsSection
          title="运动学 · Left Mouth FiveBar"
          k={diag.kinematics?.leftMouthFiveBar || diag.kinematics?.leftMouthCorner || diag.kinematics?.leftMouthCornerFivebar}
          controlId="mouth_corner_l"
          configs={configs}
          logicalPose={diag.logicalPose}
        />
      </div>

      <div className="sdk-servo-inspector-block sdk-servo-inspector-block--current">
        <h4 className="sdk-servo-inspector-subtitle">当前帧问题</h4>
        {diag.currentIssues.length === 0 ? (
          <p className="sdk-servo-inspector-hint">当前帧未发现明显输出链路问题。</p>
        ) : (
          <ul className="sdk-servo-inspector-list sdk-servo-inspector-list--current">
            {diag.currentIssues.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="sdk-servo-inspector-block sdk-servo-inspector-block--config">
        <h4 className="sdk-servo-inspector-subtitle">配置风险</h4>
        {diag.configRisks.length === 0 ? (
          <p className="sdk-servo-inspector-hint">暂无配置层风险提示。</p>
        ) : (
          <>
            <ul className="sdk-servo-inspector-list sdk-servo-inspector-list--config">
              {configRisksVisible.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            {configRisksHiddenCount > 0 && !configRisksExpanded ? (
              <button
                type="button"
                className="btn-ghost btn-tiny sdk-servo-inspector-expand"
                onClick={() => setConfigRisksExpanded(true)}
              >
                展开其余 {configRisksHiddenCount} 条
              </button>
            ) : null}
            {configRisksExpanded && diag.configRisks.length > 5 ? (
              <button
                type="button"
                className="btn-ghost btn-tiny sdk-servo-inspector-expand"
                onClick={() => setConfigRisksExpanded(false)}
              >
                收起
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="sdk-servo-inspector-block sdk-servo-inspector-block--motion">
        <h4 className="sdk-servo-inspector-subtitle">当前有效运动（中 / 强）</h4>
        {motionStrongMedium.length === 0 ? (
          <p className="sdk-servo-inspector-hint">当前帧无中、强强度绑定输出。</p>
        ) : (
          <ul className="sdk-servo-inspector-list sdk-servo-inspector-list--motion">
            {motionStrongMedium.map((m) => (
              <li key={m.bindingId}>{m.summaryLine}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="sdk-servo-inspector-toolbar">
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          仅启用
        </label>
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyCurrentIssues}
            onChange={(e) => setOnlyCurrentIssues(e.target.checked)}
          />
          仅当前问题
        </label>
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyConfigRisks}
            onChange={(e) => setOnlyConfigRisks(e.target.checked)}
          />
          仅配置风险
        </label>
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyEffectiveMotion}
            onChange={(e) => setOnlyEffectiveMotion(e.target.checked)}
          />
          仅有效运动
        </label>
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyMediumStrong}
            onChange={(e) => setOnlyMediumStrong(e.target.checked)}
          />
          仅中/强
        </label>
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyDuplicateServo}
            onChange={(e) => setOnlyDuplicateServo(e.target.checked)}
          />
          仅重复 servoId
        </label>
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyWarnings}
            onChange={(e) => setOnlyWarnings(e.target.checked)}
          />
          仅告警行
        </label>
        <label className="sdk-servo-inspector-check">
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
          />
          仅有位移（|Δ|≥1us）
        </label>
        <span className="sdk-servo-inspector-sort">
          <span>排序</span>
          <select
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value)
            }}
          >
            <option value="servoId">servoId</option>
            <option value="controlId">controlId.channel</option>
          </select>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setSortAsc((v) => !v)}>
            {sortAsc ? "升序" : "降序"}
          </button>
        </span>
      </div>

      <div className="sdk-servo-inspector-scroll">
        <table className="sdk-servo-inspector-table">
          <thead>
            <tr>
              <th>控件.通道</th>
              <th>sid</th>
              <th>raw</th>
              <th>norm</th>
              <th>方向</th>
              <th>行程</th>
              <th>Δ</th>
              <th>强度</th>
              <th>使用比</th>
              <th>N</th>
              <th>+T</th>
              <th>-T</th>
              <th>act</th>
              <th>告警</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r) => (
              <tr key={r.bindingId} className={rowMotionClass(r)}>
                <td>
                  {r.controlId}.{r.channel}
                </td>
                <td>{r.servoId}</td>
                <td>{fmt(r.rawControlValue)}</td>
                <td>{fmt(r.normalizedValue)}</td>
                <td>{dirZh(r.activeDirection)}</td>
                <td>{fmtInt(r.activeSpan)}</td>
                <td>{fmtInt(r.deltaFromNeutral)}</td>
                <td className="sdk-servo-inspector-motion-label">{r.motionLabel}</td>
                <td>{pctRatio(r.activeUsageRatio)}</td>
                <td>{fmtInt(r.neutralPwm)}</td>
                <td>{fmtInt(r.positiveTargetPwm)}</td>
                <td>{fmtInt(r.negativeTargetPwm)}</td>
                <td>{fmtInt(r.actualPwm)}</td>
                <td className="sdk-servo-inspector-flags">
                  {!r.enabled ? <span title="未启用">off </span> : null}
                  {r.duplicateServoWarning ? <span title="重复 servoId">dup </span> : null}
                  {r.smallMotionWarning ? <span title="raw 明显但 Δ 小">rw </span> : null}
                  {r.clipped ? <span title="限幅">clip </span> : null}
                  {r.onConflictServoDrive ? <span title="同舵机多路驱动">multi </span> : null}
                  {r.supersededByFiveBarIk ? <span title="由右嘴角五杆 IK 覆盖">5bar </span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="sdk-servo-inspector-subtitle">finalServoOutputs · Actuator 输出诊断</h4>
      <div className="sdk-servo-inspector-scroll sdk-servo-inspector-scroll--short">
        <table className="sdk-servo-inspector-table">
          <thead>
            <tr>
              <th>actuatorKey</th>
              <th>legacy</th>
              <th>sourceChannel</th>
              <th>logical</th>
              <th>pwm</th>
              <th>outputType</th>
              <th>busId</th>
              <th>protocol</th>
              <th>targetPos</th>
            </tr>
          </thead>
          <tbody>
            {actuatorOutputRows.length === 0 ? (
              <tr>
                <td colSpan={9} className="sdk-servo-inspector-hint">
                  当前帧无绑定输出。
                </td>
              </tr>
            ) : (
              actuatorOutputRows.map((o) => (
                <tr key={o.actuatorKey}>
                  <td>{o.actuatorKey}</td>
                  <td>{fmtInt(o.legacyServoIndex)}</td>
                  <td>{o.sourceChannel ?? "—"}</td>
                  <td>{fmtInt(o.logicalValue)}</td>
                  <td>{fmtInt(o.pwmValue)}</td>
                  <td>{o.outputType ?? (o.profileResolveReason ? "—" : "")}</td>
                  <td>{o.busServoId != null ? fmtInt(o.busServoId) : "—"}</td>
                  <td>{o.protocol ?? "—"}</td>
                  <td>
                    {o.targetPosition != null ? fmtInt(o.targetPosition) : "—"}
                    {o.isClamped ? " (clip)" : ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h4 className="sdk-servo-inspector-subtitle">当前帧 · 各舵机合成 PWM（相对中性 idle）</h4>
      <div className="sdk-servo-inspector-scroll sdk-servo-inspector-scroll--short">
        <table className="sdk-servo-inspector-table">
          <thead>
            <tr>
              <th>servoId</th>
              <th>logical</th>
              <th>actual</th>
              <th>idle actual</th>
              <th>Δ vs idle</th>
              <th>限幅</th>
            </tr>
          </thead>
          <tbody>
            {servoRowsSorted.map((s) => (
              <tr key={s.servoId} className={s.clipped ? "sdk-servo-inspector-row--clip" : ""}>
                <td>{s.servoId}</td>
                <td>{fmtInt(s.logicalPwm)}</td>
                <td>{fmtInt(s.actualPwm)}</td>
                <td>{fmtInt(s.idleActualPwm)}</td>
                <td>{fmtInt(s.deltaActualVsIdle)}</td>
                <td>{s.clipped ? "是" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="sdk-servo-inspector-subtitle">Sweep Control（单通道端点 → PWM）</h4>
      <div className="sdk-servo-inspector-sweep-bar">
        <label>
          <span>通道</span>
          <select
            value={sweepKey}
            onChange={(e) => setSweepKey(e.target.value)}
            disabled={channelOptions.length === 0}
          >
            {channelOptions.map((o) => (
              <option key={o.label} value={`${o.controlId}\t${o.channel}`}>
                {o.label}（{o.mode}）
              </option>
            ))}
          </select>
        </label>
        {sweep.error ? <span className="sdk-servo-inspector-err">{sweep.error}</span> : null}
      </div>
      {sweep.steps?.length > 0 ? (
        <div className="sdk-servo-inspector-scroll sdk-servo-inspector-scroll--short">
          <table className="sdk-servo-inspector-table">
            <thead>
              <tr>
                <th>测试点</th>
                <th>raw</th>
                {sweepServoIds.map((id) => (
                  <th key={id}>#{id} act</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sweep.steps.map((st) => (
                <tr key={st.label}>
                  <td>{st.label}</td>
                  <td>{fmtInt(st.testRaw)}</td>
                  {sweepServoIds.map((id) => (
                    <td key={id}>{fmtInt(st.actualPose?.[String(id)])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="sdk-servo-inspector-footnote">
        本面板仅调用与绑定页相同的 <code>mapFaceRigToPose</code> / <code>logicalToActualPwm</code> 做离线计算，不写入串口。
        {sweep.mode ? ` Sweep 模式：${sweep.mode}。` : ""}
      </p>
    </div>
  )
}
