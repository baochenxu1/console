import { createInitialEliteRig } from "../../core/faceDofMapper.js"

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function sideFromRig(side) {
  if (!side || typeof side !== "object") {
    return { tip: 0, tipA: 0, tipB: 0, x: 0, y: 0, mid: 0, tail: 0, inner: 0, outer: 0, absMax: 0 }
  }
  const tipA = num(side.tipA ?? side.tip ?? side.y)
  const tipB = num(side.tipB ?? side.x)
  const tip = tipA
  const mid = num(side.mid)
  const tail = num(side.tail)
  const inner = num(side.inner)
  const outer = num(side.outer)
  const x = side.x != null ? num(side.x) : tipB
  const y = side.y != null ? num(side.y) : tipA
  return {
    tip,
    tipA,
    tipB,
    x,
    y,
    mid,
    tail,
    inner,
    outer,
    absMax: Math.max(
      Math.abs(tipA),
      Math.abs(tipB),
      Math.abs(x),
      Math.abs(y),
      Math.abs(mid),
      Math.abs(tail),
      Math.abs(inner),
      Math.abs(outer)
    ),
  }
}

function sideFromMappingScalars(mapping) {
  if (!mapping || typeof mapping !== "object") {
    return null
  }
  const browL = {
    tip: num(mapping.browLeftTip),
    mid: num(mapping.browLeftMid),
    tail: num(mapping.browLeftTail),
  }
  const browR = {
    tip: num(mapping.browRightTip),
    mid: num(mapping.browRightMid),
    tail: num(mapping.browRightTail),
  }
  const absMax = Math.max(
    Math.abs(browL.tip),
    Math.abs(browL.mid),
    Math.abs(browL.tail),
    Math.abs(browR.tip),
    Math.abs(browR.mid),
    Math.abs(browR.tail)
  )
  if (absMax <= 0) {
    return null
  }
  return {
    browL: { ...browL, absMax: Math.max(Math.abs(browL.tip), Math.abs(browL.mid), Math.abs(browL.tail)) },
    browR: { ...browR, absMax: Math.max(Math.abs(browR.tip), Math.abs(browR.mid), Math.abs(browR.tail)) },
    sourcePath: "debug.mapping",
  }
}

function sideFromMappingBefore(before, prefix) {
  if (!before) {
    return { tip: 0, mid: 0, tail: 0, inner: 0, outer: 0, absMax: 0 }
  }
  const tip = num(before[`${prefix}Tip`])
  const mid = num(before[`${prefix}Mid`])
  const tail = num(before[`${prefix}Tail`])
  const inner = num(before.browInner)
  const outer = num(before[`${prefix === "browLeft" ? "browOuterLeft" : "browOuterRight"}`])
  return {
    tip,
    mid,
    tail,
    inner,
    outer,
    absMax: Math.max(Math.abs(tip), Math.abs(mid), Math.abs(tail)),
  }
}

/** 从 browGate.before 还原 raw 侧结构 */
export function buildBrowRawFromGateBefore(browGate) {
  const before = browGate?.before
  if (!before || typeof before !== "object") {
    return null
  }
  return {
    browL: sideFromMappingBefore(before, "browLeft"),
    browR: sideFromMappingBefore(before, "browRight"),
  }
}

/**
 * 解析 rig 中眉毛字段（兼容多种历史字段）。
 */
export function resolveBrowFromRigPayload(rig) {
  if (!rig || typeof rig !== "object") {
    return {
      browL: sideFromRig(null),
      browR: sideFromRig(null),
      sourcePath: "empty",
      inputKeys: [],
    }
  }

  const inputKeys = Object.keys(rig)
  if (rig.browL && rig.browR) {
    return {
      browL: sideFromRig(rig.browL),
      browR: sideFromRig(rig.browR),
      sourcePath: "rig.browL/browR",
      inputKeys,
    }
  }
  if (rig.brows?.browL && rig.brows?.browR) {
    return {
      browL: sideFromRig(rig.brows.browL),
      browR: sideFromRig(rig.brows.browR),
      sourcePath: "rig.brows",
      inputKeys,
    }
  }

  return {
    browL: sideFromRig(rig.browL),
    browR: sideFromRig(rig.browR),
    sourcePath: "rig.partial",
    inputKeys,
  }
}

const SUPPRESS_GATE_ACTIONS = new Set([
  "lock_zero",
  "lock_zero_artifact",
  "lock_brow_artifact",
  "suppress_mouth",
  "suppress_lip_artifact_weak_brow",
])

export function isBrowGatePassAction(gate) {
  const action = String(gate?.action || gate?.gateAction || "")
  if (!action || action === "normal") return true
  if (SUPPRESS_GATE_ACTIONS.has(action)) return false
  return action.includes("pass") || action.startsWith("pass_")
}

/** 小范围抖动置零（保留大动响应；用于 runtime brow 直通后处理） */
export const DEFAULT_BROW_MICRO_JITTER = {
  enabled: true,
  /** |v| ≤ snapAbs 直接置 0 */
  snapAbs: 2.8,
  /** 迟滞：从 0 区离开需 |v| ≥ zeroExit */
  zeroEnter: 4.5,
  zeroExit: 7,
}

/** runtime brow 直通时的 per-frame slew（抑制 pass_explicit 伪跳变） */
export const DEFAULT_BROW_RUNTIME_PASS = {
  maxDeltaPerFrame: 24,
  passExplicitMaxDeltaPerFrame: 12,
  /** 大幅 pass 需 browVeryStrongEvidence，否则用更严限额 */
  requireVeryStrongForLargePass: true,
  largePassAbsThreshold: 16,
  weakPassMaxDeltaPerFrame: 8,
}

/** 眼睑 / eyeXY 小范围置零（与 brow 同结构，量纲均为 FaceRig signed） */
export const DEFAULT_EYE_MICRO_JITTER = {
  enabled: true,
  snapAbs: 2.5,
  zeroEnter: 4,
  zeroExit: 6.5,
}

function filterMicroJitterChannel(prev, next, cfg) {
  if (cfg?.enabled === false) {
    return num(next)
  }
  const p = num(prev)
  const n = num(next)
  const an = Math.abs(n)
  const ap = Math.abs(p)
  const snap = Math.max(0, Number(cfg.snapAbs) || 0)
  const enter = Math.max(0, Number(cfg.zeroEnter) || 0)
  const exit = Math.max(enter + 1e-6, Number(cfg.zeroExit) || enter + 1)

  if (an <= snap) {
    return 0
  }
  if (ap <= enter && an < exit) {
    return 0
  }
  if (ap < exit && an < exit) {
    return 0
  }
  return n
}

function filterBrowSideMicroJitter(prevSide, nextSide, cfg = DEFAULT_BROW_MICRO_JITTER) {
  if (!nextSide) {
    return { tip: 0, mid: 0, tail: 0 }
  }
  const prev = prevSide || { tip: 0, mid: 0, tail: 0 }
  return {
    tip: filterMicroJitterChannel(prev.tip, nextSide.tip, cfg),
    mid: filterMicroJitterChannel(prev.mid, nextSide.mid, cfg),
    tail: filterMicroJitterChannel(prev.tail, nextSide.tail, cfg),
  }
}

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function rampBrowSideRuntime(prevSide, nextSide, limit) {
  const prev = prevSide || { tip: 0, mid: 0, tail: 0 }
  const next = nextSide || { tip: 0, mid: 0, tail: 0 }
  const clamp = (p, n) => {
    const delta = Math.max(-limit, Math.min(limit, (Number(n) || 0) - (Number(p) || 0)))
    return (Number(p) || 0) + delta
  }
  return {
    tip: clamp(prev.tip, next.tip),
    mid: clamp(prev.mid, next.mid),
    tail: clamp(prev.tail, next.tail),
  }
}

function filterEyePairMicroJitter(prevPair, nextPair, cfg = DEFAULT_EYE_MICRO_JITTER) {
  if (!nextPair) {
    return { up: 0, lo: 0 }
  }
  const prev = prevPair || { up: 0, lo: 0 }
  return {
    up: filterMicroJitterChannel(prev.up, nextPair.up, cfg),
    lo: filterMicroJitterChannel(prev.lo, nextPair.lo, cfg),
  }
}

/**
 * 上层脸（brow + eyelid）小范围置零，不恢复 EMA 大延迟。
 */
export function applyUpperFaceMicroJitterFilter(
  rig,
  prevRig,
  {
    browCfg = DEFAULT_BROW_MICRO_JITTER,
    eyeCfg = DEFAULT_EYE_MICRO_JITTER,
  } = {}
) {
  if (!rig) {
    return rig
  }
  const prev = prevRig || {}
  return {
    ...rig,
    browL: filterBrowSideMicroJitter(prev.browL, rig.browL, browCfg),
    browR: filterBrowSideMicroJitter(prev.browR, rig.browR, browCfg),
    eyeL: filterEyePairMicroJitter(prev.eyeL, rig.eyeL, eyeCfg),
    eyeR: filterEyePairMicroJitter(prev.eyeR, rig.eyeR, eyeCfg),
  }
}

/**
 * Tracking 最终 rig：gate 通过时用 runtime merge 覆盖 brow，并对 pass_explicit 做 slew 防伪跳变。
 */
export function applyRuntimeBrowToRigIfGatePass(
  rig,
  debug,
  {
    prevRig = null,
    jitterCfg = DEFAULT_BROW_MICRO_JITTER,
    passCfg = DEFAULT_BROW_RUNTIME_PASS,
  } = {}
) {
  if (!rig || !debug) {
    return { rig, applied: false }
  }
  const gate = debug.brow?.gate || debug.browGate
  if (!isBrowGatePassAction(gate)) {
    return { rig, applied: false, reason: "gate-suppressed" }
  }
  const merged = mergeBrowChannelsFromDebug(debug)
  if (!merged) {
    return { rig, applied: false, reason: "no-brow-source" }
  }

  const gateAction = String(gate?.gateAction || gate?.action || "")
  const isPassExplicit =
    gateAction === "pass_explicit" || gateAction.includes("pass_explicit")
  const veryStrong = Boolean(gate?.browVeryStrongEvidence)
  const absMax = Math.max(
    Math.abs(merged.browL.tip),
    Math.abs(merged.browL.mid),
    Math.abs(merged.browL.tail),
    Math.abs(merged.browR.tip),
    Math.abs(merged.browR.mid),
    Math.abs(merged.browR.tail)
  )

  let limit = numOr(passCfg.maxDeltaPerFrame, 24)
  if (isPassExplicit) {
    limit = numOr(passCfg.passExplicitMaxDeltaPerFrame, 12)
    if (
      passCfg.requireVeryStrongForLargePass !== false &&
      absMax >= numOr(passCfg.largePassAbsThreshold, 16) &&
      !veryStrong
    ) {
      limit = Math.min(limit, numOr(passCfg.weakPassMaxDeltaPerFrame, 8))
    }
  }

  const rampedL = rampBrowSideRuntime(prevRig?.browL, merged.browL, limit)
  const rampedR = rampBrowSideRuntime(prevRig?.browR, merged.browR, limit)
  const browL = filterBrowSideMicroJitter(prevRig?.browL, rampedL, jitterCfg)
  const browR = filterBrowSideMicroJitter(prevRig?.browR, rampedR, jitterCfg)
  return {
    rig: {
      ...rig,
      browL: { tip: browL.tip, mid: browL.mid, tail: browL.tail },
      browR: { tip: browR.tip, mid: browR.mid, tail: browR.tail },
    },
    applied: true,
    sourcePath: merged.sourcePath,
    runtimePass: { gateAction, limit, absMax, veryStrong },
  }
}

function pickChannelValue(finalV, mappingV, rawV, threshold = 1) {
  const fv = num(finalV)
  const mv = num(mappingV)
  const rv = num(rawV)
  const pick = (v) => (Math.abs(v) >= threshold ? v : null)
  return pick(fv) ?? pick(mv) ?? pick(rv) ?? fv
}

/**
 * 按 tip/mid/tail 逐通道合并眉毛（避免 debug.brow.final 有 tip/mid 但 tail=0 时丢弃 raw/mapping 的 tail）。
 */
export function mergeBrowChannelsFromDebug(debug) {
  if (!debug || typeof debug !== "object") {
    return null
  }

  const finL = debug.brow?.final?.browL
  const finR = debug.brow?.final?.browR
  const map = debug.mapping
  const rawSide = debug.brow?.raw || buildBrowRawFromGateBefore(debug.browGate)
  const rawL = rawSide?.browL
  const rawR = rawSide?.browR

  const browL = {
    tip: pickChannelValue(finL?.tip, map?.browLeftTip, rawL?.tip),
    mid: pickChannelValue(finL?.mid, map?.browLeftMid, rawL?.mid),
    tail: pickChannelValue(finL?.tail, map?.browLeftTail, rawL?.tail),
  }
  const browR = {
    tip: pickChannelValue(finR?.tip, map?.browRightTip, rawR?.tip),
    mid: pickChannelValue(finR?.mid, map?.browRightMid, rawR?.mid),
    tail: pickChannelValue(finR?.tail, map?.browRightTail, rawR?.tail),
  }

  const absMax = Math.max(
    Math.abs(browL.tip),
    Math.abs(browL.mid),
    Math.abs(browL.tail),
    Math.abs(browR.tip),
    Math.abs(browR.mid),
    Math.abs(browR.tail)
  )
  if (absMax <= 0) {
    return null
  }

  return {
    browL: { ...browL, absMax: Math.max(Math.abs(browL.tip), Math.abs(browL.mid), Math.abs(browL.tail)) },
    browR: { ...browR, absMax: Math.max(Math.abs(browR.tip), Math.abs(browR.mid), Math.abs(browR.tail)) },
    sourcePath: "runtime-merge",
  }
}

/**
 * 运行时眉毛数据源（逐通道 merge，不读已被 FaceRig 覆盖的 mapping.brows.final）。
 */
export function resolveRuntimeBrowSource(debug) {
  return mergeBrowChannelsFromDebug(debug)
}

/**
 * 从 debug.brow.final / debug.mapping 解析 gate 后眉毛（rig 缺字段时的回退源）。
 */
export function resolveBrowFromFrameDebug(debug) {
  return resolveRuntimeBrowSource(debug)
}

/**
 * rig 眉毛近零但 runtime brow 有输出时写回 rig（修复 mapping→FaceRig 断链）。
 */
export function injectFrameDebugBrowIntoRig(rig, debug, { absThreshold = 1 } = {}) {
  const base =
    rig && typeof rig === "object"
      ? {
          ...rig,
          browL: { ...(rig.browL || { tip: 0, mid: 0, tail: 0 }) },
          browR: { ...(rig.browR || { tip: 0, mid: 0, tail: 0 }) },
        }
      : createInitialEliteRig()

  const current = resolveBrowFromRigPayload(base)
  const beforeFaceRig = {
    browL: { ...base.browL },
    browR: { ...base.browR },
  }

  const gate = debug?.brow?.gate || debug?.browGate
  const gatePass = isBrowGatePassAction(gate)

  const mapped = resolveRuntimeBrowSource(debug)
  if (!mapped) {
    return {
      rig: base,
      injected: false,
      sourcePath: null,
      browInjectionDebug: { injected: false, source: "none", beforeFaceRig, afterFaceRig: beforeFaceRig },
    }
  }

  const afterFaceRig = {
    browL: { tip: mapped.browL.tip, mid: mapped.browL.mid, tail: mapped.browL.tail },
    browR: { tip: mapped.browR.tip, mid: mapped.browR.mid, tail: mapped.browR.tail },
  }

  const channelChanged = (sideKey, field) =>
    Math.abs(num(afterFaceRig[sideKey][field]) - num(beforeFaceRig[sideKey][field])) >= 1

  const hasMissingChannel = (sideKey) =>
    ["tip", "mid", "tail"].some((field) => {
      const mappedVal = Math.abs(num(mapped[sideKey][field]))
      const currentVal = Math.abs(num(beforeFaceRig[sideKey][field]))
      return mappedVal >= absThreshold && currentVal < 1
    })

  const needsInject =
    gatePass &&
    (Math.max(mapped.browL.absMax, mapped.browR.absMax) >= absThreshold ||
      channelChanged("browL", "tip") ||
      channelChanged("browL", "mid") ||
      channelChanged("browL", "tail") ||
      channelChanged("browR", "tip") ||
      channelChanged("browR", "mid") ||
      channelChanged("browR", "tail") ||
      hasMissingChannel("browL") ||
      hasMissingChannel("browR"))

  if (!gatePass) {
    const zeroSide = { tip: 0, mid: 0, tail: 0 }
    return {
      rig: { ...base, browL: zeroSide, browR: zeroSide },
      injected: true,
      sourcePath: "gate-locked-zero",
      browInjectionDebug: {
        injected: true,
        source: "gate-locked-zero",
        beforeFaceRig,
        afterFaceRig: { browL: zeroSide, browR: zeroSide },
      },
    }
  }

  if (
    !needsInject &&
    !hasMissingChannel("browL") &&
    !hasMissingChannel("browR") &&
    Math.max(current.browL.absMax, current.browR.absMax) >= absThreshold
  ) {
    return {
      rig: base,
      injected: false,
      sourcePath: current.sourcePath,
      browInjectionDebug: { injected: false, source: "none", beforeFaceRig, afterFaceRig: beforeFaceRig },
    }
  }

  return {
    rig: {
      ...base,
      ...afterFaceRig,
    },
    injected: true,
    sourcePath: mapped.sourcePath,
    browInjectionDebug: {
      injected: true,
      source: mapped.sourcePath,
      beforeFaceRig,
      afterFaceRig,
    },
  }
}

function pickGate(debug) {
  const g = debug?.brow?.gate
  if (g && typeof g === "object") {
    return g
  }
  const bg = debug.browGate
  if (!bg) {
    return null
  }
  return {
    action: bg.gateAction,
    decisionReason: bg.decisionReason,
    classifierReason: bg.classifierReason,
    neutralReady: bg.neutralReady,
    neutralReadyDetails: bg.neutralReadyDetails,
    neutralFallback: bg.neutralFallback,
    neutralCount: bg.neutralCount,
    neutralRequired: bg.neutralRequired,
    headMotionLikely: bg.headMotionLikely,
    mouthMotionLikely: bg.mouthMotionLikely,
    browSafePose: bg.browSafePose,
    explicitBrowActive: bg.explicitBrowActive,
    explicitBrowCount: bg.explicitBrowCount,
    immediateArtifactLock: bg.immediateArtifactLock,
    immediateArtifactReason: bg.immediateArtifactReason,
    immediateArtifactAppliesToBrow: bg.immediateArtifactAppliesToBrow,
    lipOnlyImmediateArtifact: bg.lipOnlyImmediateArtifact,
    browArtifactLock: bg.browArtifactLock,
    browStrongEvidence: bg.browStrongEvidence,
    browVeryStrongEvidence: bg.browVeryStrongEvidence,
    outputScale: bg.outputScale ?? bg.suppressScale,
    browAbsMax: bg.browAbsMax,
  }
}

function browLockHint(gate) {
  if (!gate) {
    return ""
  }
  const action = String(gate.action || gate.gateAction || "")
  const reason = String(gate.decisionReason || "")
  if (action === "lock_brow_artifact" || reason === "brow-artifact-lock") {
    return "locked by browArtifactLock"
  }
  if (reason === "neutral-not-ready") {
    return "locked by neutral-not-ready"
  }
  if (reason === "head-motion-weak-brow") {
    return "locked by head-motion-weak-brow"
  }
  if (reason === "lip-artifact-weak-brow-lock") {
    return "locked by lip-artifact weak brow"
  }
  if (action === "lock_zero" || action.startsWith("lock_")) {
    return `locked (${reason || action})`
  }
  return ""
}

function pickBrowSideValues(side) {
  if (!side) {
    return { lTip: 0, lMid: 0, lTail: 0, rTip: 0, rMid: 0, rTail: 0 }
  }
  return {
    lTip: num(side.browL?.tip),
    lMid: num(side.browL?.mid),
    lTail: num(side.browL?.tail),
    rTip: num(side.browR?.tip),
    rMid: num(side.browR?.mid),
    rTail: num(side.browR?.tail),
  }
}

function absMaxOfSideValues(v) {
  return Math.max(
    Math.abs(v.lTip),
    Math.abs(v.lMid),
    Math.abs(v.lTail),
    Math.abs(v.rTip),
    Math.abs(v.rMid),
    Math.abs(v.rTail)
  )
}

const BROW_PIPELINE_CHANNELS = [
  { map: "lTip", face: "lTip", bind: "lTip", label: "brow-l-tip" },
  { map: "lMid", face: "lMid", bind: null, label: "brow-l-mid" },
  { map: "lTail", face: "lTail", bind: "lTail", label: "brow-l-tail" },
  { map: "rTip", face: "rTip", bind: "rTip", label: "brow-r-tip" },
  { map: "rMid", face: "rMid", bind: null, label: "brow-r-mid" },
  { map: "rTail", face: "rTail", bind: "rTail", label: "brow-r-tail" },
]

function browPipelineThreshold(field) {
  return field.endsWith("Mid") ? 5 : 10
}

/**
 * mapping final → faceRig → binding 一致性诊断（逐通道）。
 */
export function buildBrowPipelineConsistency({
  mappingFinal = null,
  faceRigChannel = null,
  bindingRawControl = null,
} = {}) {
  const mapping = pickBrowSideValues(mappingFinal)
  const faceRig = pickBrowSideValues(faceRigChannel)
  const binding = bindingRawControl || {}

  const mappingAbs = absMaxOfSideValues(mapping)
  const faceRigAbs = absMaxOfSideValues(faceRig)
  const bindingAbs = Math.max(
    Math.abs(num(binding.lTip)),
    Math.abs(num(binding.lTail)),
    Math.abs(num(binding.rTip)),
    Math.abs(num(binding.rTail))
  )

  let consistent = true
  let mismatchReason = ""

  for (const ch of BROW_PIPELINE_CHANNELS) {
    const mAbs = Math.abs(num(mapping[ch.map]))
    const fAbs = Math.abs(num(faceRig[ch.face]))
    const thr = browPipelineThreshold(ch.map)
    if (mAbs > thr && fAbs < 1) {
      consistent = false
      mismatchReason = `mapping-final-to-face-rig-${ch.label}-mismatch`
      break
    }
    if (ch.bind) {
      const bAbs = Math.abs(num(binding[ch.bind]))
      if (fAbs > thr && bAbs < 1) {
        consistent = false
        mismatchReason = `face-rig-to-binding-${ch.label}-mismatch`
        break
      }
    }
  }

  if (consistent && mappingAbs > 10 && faceRigAbs < 1) {
    consistent = false
    mismatchReason = "mapping-final-not-written-to-faceRig"
  } else if (consistent && faceRigAbs > 10 && bindingAbs < 1) {
    consistent = false
    mismatchReason = "binding-source-resolution-failed"
  }

  return {
    mappingFinal: mapping,
    faceRigChannel: faceRig,
    bindingRawControl: {
      lTip: num(binding.lTip),
      lTail: num(binding.lTail),
      rTip: num(binding.rTip),
      rTail: num(binding.rTail),
    },
    consistent,
    mismatchReason: consistent ? "" : mismatchReason,
  }
}

/**
 * 合并 Python debug.brow + 前端校准后 rig，生成全链路 Brow Debug。
 */
export function buildBrowDebugFromFrame(frame, calibratedRig = null) {
  if (!frame || typeof frame !== "object") {
    return null
  }

  const debug = frame.debug && typeof frame.debug === "object" ? frame.debug : {}
  const browGate = debug.browGate
  const pythonBrow = debug.brow

  const raw =
    pythonBrow?.raw ||
    buildBrowRawFromGateBefore(browGate) ||
    resolveBrowFromRigPayload(frame.rig)

  const resolvedInput = resolveBrowFromRigPayload(frame.rig)
  const afterStabilizer = calibratedRig
    ? {
        browL: sideFromRig(calibratedRig.browL),
        browR: sideFromRig(calibratedRig.browR),
      }
    : pythonBrow?.afterStabilizer || raw

  const final = calibratedRig
    ? {
        browL: sideFromRig(calibratedRig.browL),
        browR: sideFromRig(calibratedRig.browR),
      }
    : pythonBrow?.final || {
        browL: sideFromRig(frame.rig?.browL),
        browR: sideFromRig(frame.rig?.browR),
      }

  const gate = pickGate(debug)
  const rawAbs = Math.max(raw.browL?.absMax ?? 0, raw.browR?.absMax ?? 0)
  const finalAbs = Math.max(final.browL?.absMax ?? 0, final.browR?.absMax ?? 0)

  let browStatusHint = ""
  if (rawAbs > 3 && finalAbs < 1) {
    browStatusHint = browLockHint(gate) || "raw exists but gated to zero"
  } else if (rawAbs < 1) {
    browStatusHint = "brow raw missing / zero"
  }

  return {
    raw,
    afterStabilizer,
    gate,
    final,
    browStatusHint,
    frontendBrowNormalize: {
      inputKeys: resolvedInput.inputKeys,
      resolvedBrowL: resolvedInput.browL,
      resolvedBrowR: resolvedInput.browR,
      sourcePath: resolvedInput.sourcePath,
    },
  }
}

/** Bypass：用 gate 前 raw 替换 rig 眉毛（保留其它通道） */
export function applyBrowGateBypass(rig, frame) {
  if (!rig || !frame) {
    return rig
  }
  const debug = frame.debug
  const raw = debug?.brow?.raw || buildBrowRawFromGateBefore(debug?.browGate)
  if (!raw?.browL || !raw?.browR) {
    return rig
  }
  return {
    ...rig,
    browL: {
      ...rig.browL,
      tip: num(raw.browL.tip),
      tipA: num(raw.browL.tipA ?? raw.browL.tip),
      tipB: num(raw.browL.tipB ?? rig.browL?.tipB ?? 0),
      mid: num(raw.browL.mid),
      tail: num(raw.browL.tail),
    },
    browR: {
      ...rig.browR,
      tip: num(raw.browR.tip),
      tipA: num(raw.browR.tipA ?? raw.browR.tip),
      tipB: num(raw.browR.tipB ?? rig.browR?.tipB ?? 0),
      mid: num(raw.browR.mid),
      tail: num(raw.browR.tail),
    },
  }
}
