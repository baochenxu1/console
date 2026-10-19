import { clampNumber } from "../../utils/clamp.js"
import {
  channelRawToDriver,
  createInitialEliteRig,
  evaluateBindingLogical,
  mapFaceRigToPose,
  rigValuesFromEliteRig,
  setEliteRigControlRaw,
} from "../../core/faceDofMapper.js"
import {
  normalizeFaceRigProfile,
  resolveBindingTargetsForEvaluate,
} from "../../core/faceRigProfile.js"
import { getServoConfig, logicalToActualPwm } from "../../core/servoConfig.js"
import { createRightMouthCornerFivebarState } from "../kinematics/mouthCornerFivebar.js"
import {
  collectServoIdsByControlIds,
  servoBlockedForMouthFiveBar,
} from "../kinematics/mouthCornerKinematics.js"
import { getMouthCornerLabSide } from "../kinematics/mouthCornerFiveBarLabConfig.js"
import { buildMapFaceRigToPoseOptionsFromMouthRuntimes } from "../kinematics/mouthFiveBarRuntimeOptions.js"

const _bindingDiagRightFiveBarState = createRightMouthCornerFivebarState()
const _bindingDiagLeftFiveBarState = createRightMouthCornerFivebarState()

function defaultMapFaceRigToPoseOptions() {
  return buildMapFaceRigToPoseOptionsFromMouthRuntimes({
    rightState: _bindingDiagRightFiveBarState,
    leftState: _bindingDiagLeftFiveBarState,
  })
}

const SMALL_MOTION_US = 30
const SMALL_SPAN_US = 150
const ASYM_RATIO = 3
/** |driver| 超过此阈值视为「控件有明显输出」用于缺失绑定检测 */
const MISSING_BINDING_DRIVER = 0.12
const RAW_OBVIOUS_NORM = 20
const MULTI_DRIVE_NORM = 10
const EPS = 1e-9

function bindingChannelLabel(b) {
  return `${b.controlId}.${b.channel}`
}

function formatSpanRisk(controlKey, directionLabel, span) {
  return `${controlKey} ${directionLabel}行程仅 ${Math.round(span)}us，可能导致动作不明显`
}

function formatAsymRisk(controlKey, posSpan, negSpan) {
  return `${controlKey} 正负向行程差异较大：+${Math.round(posSpan)}us / -${Math.round(negSpan)}us`
}

function motionLevelFromDelta(absD) {
  if (absD < 1) {
    return "neutral"
  }
  if (absD < 30) {
    return "weak"
  }
  if (absD < 80) {
    return "small"
  }
  if (absD < 200) {
    return "medium"
  }
  return "strong"
}

function motionLabelForLevel(motionLevel, deltaSigned) {
  const absD = Math.abs(deltaSigned)
  const dInt = Math.round(deltaSigned)
  const dStr = `${dInt >= 0 ? "+" : ""}${dInt}`
  switch (motionLevel) {
    case "neutral":
      return "无动作"
    case "weak":
      return `弱：Δ=${dStr}us`
    case "small":
      return `小：Δ=${dStr}us`
    case "medium":
      return `中：Δ=${dStr}us`
    case "strong":
      return `强：Δ=${dStr}us`
    default:
      return "—"
  }
}

function activeDirectionFromNorm(normalizedValue) {
  const n = Number(normalizedValue)
  if (!Number.isFinite(n)) {
    return "neutral"
  }
  if (n > EPS) {
    return "positive"
  }
  if (n < -EPS) {
    return "negative"
  }
  return "neutral"
}

function computeMotionFields(deltaFromNeutral, normalizedValue, positiveSpan, negativeSpan) {
  const delta =
    deltaFromNeutral === null || deltaFromNeutral === undefined || Number.isNaN(deltaFromNeutral)
      ? 0
      : Number(deltaFromNeutral)
  const absD = Math.abs(delta)
  const motionLevel = motionLevelFromDelta(absD)
  const activeDirection = activeDirectionFromNorm(normalizedValue)
  const activeSpan =
    activeDirection === "positive"
      ? positiveSpan
      : activeDirection === "negative"
        ? negativeSpan
        : 0
  const activeUsageRatio =
    activeSpan > EPS && absD > EPS ? clampNumber(absD / activeSpan, 0, 999) : 0

  return {
    activeDirection,
    activeSpan,
    activeUsageRatio,
    motionLevel,
    motionLabel: motionLabelForLevel(motionLevel, delta),
  }
}

function fmtDeltaSigned(delta) {
  const d = Math.round(Number(delta) || 0)
  return `${d >= 0 ? "+" : ""}${d}`
}

function buildMotionSummaryLine(r) {
  const label = bindingChannelLabel(r)
  const levelZh = { neutral: "无", weak: "弱", small: "小", medium: "中", strong: "强" }
  const head = `${label}：${levelZh[r.motionLevel] || r.motionLevel}`
  const rawPart =
    r.channelMode === "percent"
      ? `raw=${Number(r.rawControlValue).toFixed(2)}，norm=${Number(r.normalizedValue).toFixed(2)}`
      : `raw=${Number(r.rawControlValue).toFixed(2)}`
  const deltaPart = `Δ=${fmtDeltaSigned(r.deltaFromNeutral ?? 0)}us`
  let usagePart = ""
  if (r.activeDirection !== "neutral" && r.activeSpan > EPS) {
    const dirZh = r.activeDirection === "positive" ? "正向行程" : "负向行程"
    usagePart = `，使用${dirZh} ${Math.round(r.activeUsageRatio * 100)}%`
  }
  return `${head}，${rawPart}，${deltaPart}${usagePart}`
}

/**
 * Face Rig → 舵机 PWM 诊断（只读，不修改 mapping / binding 计算路径）。
 *
 * @returns {{
 *   rows: object[],
 *   warnings: string[],
 *   currentIssues: string[],
 *   configRisks: string[],
 *   motionSummary: object[],
 *   logicalPose: object,
 *   actualPose: object,
 *   servoOutputCurrent: Record<string, object>,
 *   mapWarnings: string[],
 *   kinematics: object,
 * }}
 */
export function buildBindingOutputDiagnostics({
  profile,
  rig,
  logicalPose: _logicalPose,
  configs = [],
  timeMs: _timeMs = 300,
  mapFaceRigToPoseOptions,
} = {}) {
  const mapOpts = mapFaceRigToPoseOptions ?? defaultMapFaceRigToPoseOptions()
  const currentIssues = []
  const configRisks = []

  const profileN = normalizeFaceRigProfile(profile || {})
  const cfgList = Array.isArray(configs) ? configs : []
  const rigSafe = rig && typeof rig === "object" ? rig : createInitialEliteRig()
  const rigValues = rigValuesFromEliteRig(rigSafe)
  const mapped = mapFaceRigToPose(rigValues, profileN, cfgList, mapOpts)
  const idleRigValues = rigValuesFromEliteRig(createInitialEliteRig())
  const idleMapped = mapFaceRigToPose(idleRigValues, profileN, cfgList, mapOpts)

  const supersededBindingIds = new Set()
  for (const c of mapped.contributions || []) {
    if (c.supersededByFiveBarIk) {
      supersededBindingIds.add(c.bindingId)
    }
  }

  for (const w of mapped.warnings || []) {
    configRisks.push(w)
  }

  const controlsById = new Map((profileN.controls || []).map((c) => [c.controlId, c]))
  const enabledBindings = (profileN.bindings || []).filter((b) => b.enabled)

  const servoToActiveBindings = new Map()
  for (const b of enabledBindings) {
    if (!servoToActiveBindings.has(b.servoId)) {
      servoToActiveBindings.set(b.servoId, [])
    }
    servoToActiveBindings.get(b.servoId).push(b)
  }

  for (const [sid, list] of servoToActiveBindings) {
    if (list.length > 1) {
      const parts = list.map((b) => `${b.controlId}.${b.channel}`)
      configRisks.push(`servoId ${sid} 被多个控件绑定：${parts.join("，")}`)
    }
  }

  const lipServos = collectServoIdsByControlIds(profileN, [
    "mouth_ul",
    "mouth_ur",
    "mouth_ll",
    "mouth_lr",
  ])
  for (const sideId of ["right", "left"]) {
    const side = getMouthCornerLabSide(sideId)
    for (const b of enabledBindings) {
      if (b.controlId !== side.controlId) {
        continue
      }
      if (b.channel !== "x" && b.channel !== "y") {
        continue
      }
      if (lipServos.has(Number(b.servoId))) {
        configRisks.push(
          `servoId ${b.servoId}：${side.controlId}.${b.channel} 与唇瓣控件绑定冲突，嘴角五杆无法占用该舵机`
        )
      }
    }
  }
  for (const b of enabledBindings) {
    if (!lipServos.has(Number(b.servoId))) {
      continue
    }
    if (!["mouth_ul", "mouth_ur", "mouth_ll", "mouth_lr"].includes(b.controlId)) {
      continue
    }
    configRisks.push(
      `${b.controlId} → servoId ${b.servoId}：唇瓣线性绑定优先于嘴角五杆 IK（拖动此控件应直接驱动该舵机）`
    )
  }

  const boundKeys = new Set(
    enabledBindings.map((b) => `${b.controlId}\t${b.channel}`)
  )

  for (const ctrl of profileN.controls || []) {
    const cid = ctrl.controlId
    for (const channel of Object.keys(ctrl.channels || {})) {
      const spec = ctrl.channels[channel]
      const raw = rigValues[cid]?.[channel]
      if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
        continue
      }
      if (!hasSignificantDriver(raw, spec)) {
        continue
      }
      const key = `${cid}\t${channel}`
      if (!boundKeys.has(key)) {
        currentIssues.push(
          channel === "value"
            ? `${cid} 有输出但未绑定舵机`
            : `${cid}.${channel} 有输出但未绑定舵机`
        )
      }
    }
  }

  const rows = []

  for (const binding of profileN.bindings || []) {
    const ctrl = controlsById.get(binding.controlId)
    const spec = ctrl?.channels?.[binding.channel]
    const channelMode = spec?.mode || "signed100"

    let rawControlValue = null
    let normalizedValue = null
    let driver = 0
    let rawMissing = false

    if (!spec) {
      rawMissing = true
    } else {
      const raw = rigValues[binding.controlId]?.[binding.channel]
      if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
        rawMissing = true
      } else {
        const n = Number(raw)
        rawControlValue = channelMode === "percent" ? clampNumber(n, 0, 100) : clampNumber(n, -100, 100)
        normalizedValue =
          channelMode === "percent" ? (n - 50) * 2 : clampNumber(n, -100, 100)
        driver = channelRawToDriver(n, spec)
      }
    }

    const resolved = spec
      ? resolveBindingTargetsForEvaluate(binding)
      : {
          neutralPwm: binding.neutralPwm,
          positiveTargetPwm: binding.positiveTargetPwm,
          negativeTargetPwm: binding.negativeTargetPwm,
        }
    const n = resolved.neutralPwm
    const posT = resolved.positiveTargetPwm
    const negT = resolved.negativeTargetPwm
    const positiveSpan = Math.abs(posT - n)
    const negativeSpan = Math.abs(n - negT)

    let configRiskSmallSpanPos = false
    let configRiskSmallSpanNeg = false
    let configRiskAsymmetric = false
    let configRiskCollapsedTargets = false

    if (binding.enabled && spec) {
      if (binding.positiveTargetPwm === binding.negativeTargetPwm) {
        configRiskCollapsedTargets = true
        configRisks.push(
          `${bindingChannelLabel(binding)} 正负目标相同（${binding.positiveTargetPwm}），控件双向同向；请在绑定检视器中修正`
        )
      }
      if (positiveSpan < SMALL_SPAN_US) {
        configRiskSmallSpanPos = true
        configRisks.push(formatSpanRisk(bindingChannelLabel(binding), "正向", positiveSpan))
      }
      if (negativeSpan < SMALL_SPAN_US) {
        configRiskSmallSpanNeg = true
        configRisks.push(formatSpanRisk(bindingChannelLabel(binding), "负向", negativeSpan))
      }
      const lo = Math.min(positiveSpan, negativeSpan)
      const hi = Math.max(positiveSpan, negativeSpan)
      if (lo > EPS && hi / lo >= ASYM_RATIO) {
        configRiskAsymmetric = true
        configRisks.push(formatAsymRisk(bindingChannelLabel(binding), positiveSpan, negativeSpan))
      }
    }

    let logicalPwm = null
    let usedTargetPwm = null
    if (!rawMissing && spec && binding.enabled) {
      logicalPwm = evaluateBindingLogical(driver, binding)
      usedTargetPwm = driver >= 0 ? posT : negT
    } else if (!rawMissing && spec) {
      logicalPwm = evaluateBindingLogical(driver, binding)
      usedTargetPwm = driver >= 0 ? posT : negT
    }

    const sidStr = String(binding.servoId)
    const mergedLogicalPwm =
      mapped.logicalPose[sidStr] !== undefined ? mapped.logicalPose[sidStr] : null
    const actualPwm =
      mapped.actualPose[sidStr] !== undefined ? mapped.actualPose[sidStr] : null

    const cfg = getServoConfig(cfgList, binding.servoId)
    let clipped = false
    if (
      mergedLogicalPwm !== null &&
      mergedLogicalPwm !== undefined &&
      cfg.enabled !== false
    ) {
      clipped = logicalToActualPwm(mergedLogicalPwm, cfg).limited
    }

    const deltaFromNeutral =
      logicalPwm !== null && logicalPwm !== undefined
        ? logicalPwm - binding.neutralPwm
        : null

    const duplicateServoWarning =
      binding.enabled && (servoToActiveBindings.get(binding.servoId)?.length || 0) > 1

    const mf = computeMotionFields(
      deltaFromNeutral,
      normalizedValue,
      positiveSpan,
      negativeSpan
    )

    const absNorm = Number.isFinite(Number(normalizedValue)) ? Math.abs(Number(normalizedValue)) : 0
    const absDelta =
      deltaFromNeutral !== null && deltaFromNeutral !== undefined && Number.isFinite(deltaFromNeutral)
        ? Math.abs(deltaFromNeutral)
        : 0

    const rawObviousSmallPwm =
      binding.enabled &&
      absNorm >= RAW_OBVIOUS_NORM &&
      deltaFromNeutral !== null &&
      absDelta < SMALL_MOTION_US

    if (rawObviousSmallPwm) {
      currentIssues.push(
        `${bindingChannelLabel(binding)} 控件输出明显，但当前 PWM 仅变化 ${Math.round(absDelta)}us，真实动作可能不可见`
      )
    }

    if (binding.enabled && clipped) {
      currentIssues.push(`${bindingChannelLabel(binding)} 输出被舵机限位裁剪`)
    }

    const smallMotionWarning = rawObviousSmallPwm

    const hasConfigRisk =
      duplicateServoWarning ||
      configRiskCollapsedTargets ||
      configRiskSmallSpanPos ||
      configRiskSmallSpanNeg ||
      configRiskAsymmetric

    rows.push({
      bindingId: binding.bindingId,
      controlId: binding.controlId,
      channel: binding.channel,
      servoId: binding.servoId,
      enabled: binding.enabled !== false,
      channelMode,
      rawMissing,

      rawControlValue,
      normalizedValue,

      neutralPwm: binding.neutralPwm,
      positiveTargetPwm: binding.positiveTargetPwm,
      negativeTargetPwm: binding.negativeTargetPwm,
      usedTargetPwm,

      logicalPwm,
      actualPwm,
      deltaFromNeutral,

      rangeMode: binding.rangeMode,
      weight: binding.weight,
      curve: binding.curve,

      clipped,
      smallMotionWarning,
      duplicateServoWarning,

      activeDirection: mf.activeDirection,
      activeSpan: mf.activeSpan,
      activeUsageRatio: mf.activeUsageRatio,
      motionLevel: mf.motionLevel,
      motionLabel: mf.motionLabel,

      configRiskSmallSpanPos,
      configRiskSmallSpanNeg,
      configRiskAsymmetric,
      configRiskCollapsedTargets,
      hasConfigRisk,
      rawObviousSmallPwm,
      supersededByFiveBarIk: supersededBindingIds.has(binding.bindingId),
    })
  }

  const byServoActiveNorm = new Map()
  for (const r of rows) {
    if (!r.enabled || r.rawMissing) {
      continue
    }
    const absNorm = Number.isFinite(Number(r.normalizedValue)) ? Math.abs(Number(r.normalizedValue)) : 0
    if (absNorm < MULTI_DRIVE_NORM) {
      continue
    }
    if (!byServoActiveNorm.has(r.servoId)) {
      byServoActiveNorm.set(r.servoId, [])
    }
    byServoActiveNorm.get(r.servoId).push(r)
  }

  for (const r of rows) {
    r.onConflictServoDrive = false
  }

  for (const [sid, list] of byServoActiveNorm) {
    if (list.length >= 2) {
      const parts = list.map((x) => bindingChannelLabel(x))
      currentIssues.push(`servoId ${sid} 当前被多个控件同时驱动：${parts.join("，")}`)
      for (const rr of list) {
        rr.onConflictServoDrive = true
      }
    }
  }

  for (const r of rows) {
    r.hasCurrentIssue = Boolean(
      r.rawObviousSmallPwm || (r.enabled && r.clipped) || r.onConflictServoDrive
    )
  }

  const motionSummary = []
  for (const r of rows) {
    if (!r.enabled) {
      continue
    }
    motionSummary.push({
      bindingId: r.bindingId,
      controlId: r.controlId,
      channel: r.channel,
      motionLevel: r.motionLevel,
      motionLabel: r.motionLabel,
      summaryLine: buildMotionSummaryLine(r),
      rawControlValue: r.rawControlValue,
      normalizedValue: r.normalizedValue,
      deltaFromNeutral: r.deltaFromNeutral,
      activeDirection: r.activeDirection,
      activeUsageRatio: r.activeUsageRatio,
      activeSpan: r.activeSpan,
    })
  }

  const servoIds = new Set([
    ...Object.keys(mapped.logicalPose || {}),
    ...Object.keys(mapped.actualPose || {}),
  ])

  /** @type {Record<string, object>} */
  const servoOutputCurrent = {}
  for (const sidStr of [...servoIds].sort((a, b) => Number(a) - Number(b))) {
    const servoId = Number(sidStr)
    const cfg = getServoConfig(cfgList, servoId)
    const logicalPwm = mapped.logicalPose[sidStr]
    const actualPwm = mapped.actualPose[sidStr]
    const idleActual = idleMapped.actualPose[sidStr]
    let limited = false
    if (logicalPwm !== undefined && cfg.enabled !== false) {
      limited = logicalToActualPwm(logicalPwm, cfg).limited
    }
    const idleNeutral =
      idleActual !== undefined && idleActual !== null ? idleActual : null
    const deltaVsIdle =
      actualPwm !== undefined && idleNeutral !== null
        ? actualPwm - idleNeutral
        : null

    servoOutputCurrent[sidStr] = {
      servoId,
      logicalPwm: logicalPwm ?? null,
      actualPwm: actualPwm ?? null,
      idleActualPwm: idleNeutral,
      deltaActualVsIdle: deltaVsIdle,
      clipped: limited,
    }
  }

  const warnings = [...new Set([...currentIssues, ...configRisks])]

  return {
    rows,
    warnings,
    currentIssues: [...new Set(currentIssues)],
    configRisks: [...new Set(configRisks)],
    motionSummary,
    logicalPose: mapped.logicalPose,
    actualPose: mapped.actualPose,
    servoOutputCurrent,
    mapWarnings: mapped.warnings || [],
    kinematics: mapped.kinematics || {},
  }
}

function hasSignificantDriver(raw, spec) {
  const d = Math.abs(channelRawToDriver(raw, spec))
  return d > MISSING_BINDING_DRIVER
}

/**
 * 对单通道做端点扫频，观察 PWM 是否落在足够行程内（不下发串口）。
 *
 * @returns {{ mode: string, steps: object[], error?: string }}
 */
export function buildControlChannelSweepDiagnostics({
  profile,
  configs = [],
  controlId,
  channel,
} = {}) {
  const profileN = normalizeFaceRigProfile(profile || {})
  const cfgList = Array.isArray(configs) ? configs : []
  const ctrl = profileN.controls.find((c) => c.controlId === controlId)
  const spec = ctrl?.channels?.[channel]
  if (!ctrl || !spec) {
    return { mode: "", steps: [], error: "未知控件或通道" }
  }
  const mode = spec.mode || "signed100"
  const base = createInitialEliteRig()
  const tests =
    mode === "percent"
      ? [
          { label: "0%", raw: 0 },
          { label: "50%", raw: 50 },
          { label: "100%", raw: 100 },
        ]
      : [
          { label: "-100", raw: -100 },
          { label: "0", raw: 0 },
          { label: "+100", raw: 100 },
        ]

  const steps = tests.map((t) => {
    const rig = setEliteRigControlRaw(base, controlId, channel, t.raw)
    const m = mapFaceRigToPose(
      rigValuesFromEliteRig(rig),
      profileN,
      cfgList,
      defaultMapFaceRigToPoseOptions()
    )
    return {
      label: t.label,
      testRaw: t.raw,
      logicalPose: m.logicalPose,
      actualPose: m.actualPose,
    }
  })

  return { mode, steps, error: undefined }
}

export function listProfileControlChannels(profile) {
  const profileN = normalizeFaceRigProfile(profile || {})
  const out = []
  for (const c of profileN.controls || []) {
    for (const [channel, spec] of Object.entries(c.channels || {})) {
      out.push({
        controlId: c.controlId,
        channel,
        label: `${c.controlId}.${channel}`,
        mode: spec?.mode || "signed100",
      })
    }
  }
  return out
}
