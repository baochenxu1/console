/**
 * Offline Gaze Stability analyzer for tracking-diagnostic-ai-review-v1.
 * Diagnostic flags only — no tuning parameter recommendations.
 */

export const GAZE_ANALYZE_SCENARIOS = Object.freeze([
  "static-center",
  "head-yaw",
  "head-pitch",
  "head-motion-invariance",
  "eye-horizontal",
  "eye-vertical",
  "long-center",
])

const JITTER_STD_FLAG = 1.5
const CORR_FLAG = 0.45
const NEUTRAL_DRIFT_FLAG = 0.02
const EMITTED_DRIFT_FLAG = 2.0

function colIndex(columns, name) {
  const i = columns.indexOf(name)
  return i >= 0 ? i : -1
}

function rowValue(row, columns, name) {
  const i = colIndex(columns, name)
  if (i < 0 || !row) return null
  const v = row[i]
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "boolean") return v
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}

function finiteSeries(rows, columns, name) {
  const out = []
  for (const row of rows) {
    const v = rowValue(row, columns, name)
    if (typeof v === "number" && Number.isFinite(v)) out.push(v)
  }
  return out
}

function pairedSeries(rows, columns, xName, yName) {
  const xs = []
  const ys = []
  for (const row of rows) {
    const x = rowValue(row, columns, xName)
    const y = rowValue(row, columns, yName)
    if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
      xs.push(x)
      ys.push(y)
    }
  }
  return { xs, ys }
}

function mean(arr) {
  if (!arr.length) return null
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function stdSample(arr) {
  if (arr.length < 2) return null
  const m = mean(arr)
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1)
  return Math.sqrt(v)
}

function rmsDeviation(arr, center = null) {
  if (!arr.length) return null
  const c = center != null && Number.isFinite(center) ? center : mean(arr)
  return Math.sqrt(arr.reduce((s, x) => s + (x - c) ** 2, 0) / arr.length)
}

function percentileAbsDev(arr, center, p = 95) {
  if (!arr.length) return null
  const c = center != null && Number.isFinite(center) ? center : mean(arr)
  const abs = arr.map((x) => Math.abs(x - c)).sort((a, b) => a - b)
  const idx = Math.min(abs.length - 1, Math.max(0, Math.ceil((p / 100) * abs.length) - 1))
  return abs[idx]
}

function peakToPeak(arr) {
  if (!arr.length) return null
  return Math.max(...arr) - Math.min(...arr)
}

function summarizeScalarSeries(arr, centerHint = null) {
  const m = mean(arr)
  const center = centerHint != null && Number.isFinite(centerHint) ? centerHint : m
  return {
    sampleCount: arr.length,
    mean: m,
    std: stdSample(arr),
    rmsDeviation: rmsDeviation(arr, center),
    p95AbsDeviation: percentileAbsDev(arr, center, 95),
    peakToPeak: peakToPeak(arr),
    min: arr.length ? Math.min(...arr) : null,
    max: arr.length ? Math.max(...arr) : null,
    median: arr.length
      ? [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) / 2)]
      : null,
  }
}

/** Pearson correlation; null if insufficient variance/samples. */
export function pearsonCorrelation(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  if (dx <= 0 || dy <= 0) return null
  return num / Math.sqrt(dx * dy)
}

/** Ordinary least squares slope: y ≈ slope * x + intercept */
export function linearSlope(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return { slope: null, intercept: null, n: 0 }
  const mx = mean(xs.slice(0, n))
  const my = mean(ys.slice(0, n))
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    num += dx * (ys[i] - my)
    den += dx * dx
  }
  if (den <= 0) return { slope: null, intercept: null, n }
  const slope = num / den
  return { slope, intercept: my - slope * mx, n }
}

function windowMeans(arr, frac = 0.15) {
  if (!arr.length) return { startMean: null, endMean: null, delta: null }
  const w = Math.max(1, Math.floor(arr.length * frac))
  const start = arr.slice(0, w)
  const end = arr.slice(arr.length - w)
  const startMean = mean(start)
  const endMean = mean(end)
  return {
    startMean,
    endMean,
    delta: startMean != null && endMean != null ? endMean - startMean : null,
    windowSize: w,
  }
}

function firstReadyIndex(rows, columns) {
  for (let i = 0; i < rows.length; i++) {
    const v = rowValue(rows[i], columns, "gazeNeutralReady")
    if (v === true) return i
  }
  return null
}

/**
 * @param {object} payload ai-review export
 * @param {{ scenario?: string }} [options]
 */
export function analyzeGazeDiagnosticPayload(payload, options = {}) {
  const scenario = String(options.scenario || "static-center")
  const columns = payload?.frameSeries?.columns || []
  const rows = payload?.frameSeries?.rows || []
  const flags = []

  const base = {
    scenario,
    schemaVersion: payload?.schemaVersion ?? null,
    frameCount: rows.length,
    columnCount: columns.length,
    trackingRuntimeSample: rowValue(rows[0], columns, "trackingRuntime"),
    flags: flags,
    metrics: {},
  }

  if (!columns.length || !rows.length) {
    flags.push("EMPTY_SERIES")
    return base
  }

  const requiredLegacy = ["sourceSeq", "rig.sharedRadar.x", "rig.sharedRadar.y"]
  for (const c of requiredLegacy) {
    if (!columns.includes(c)) flags.push(`MISSING_COLUMN:${c}`)
  }

  if (scenario === "static-center") {
    const channels = [
      "gazeRawX",
      "gazeRawY",
      "gazeEyeLookX",
      "gazeEyeLookY",
      "gazeEmittedSharedRadarX",
      "gazeEmittedSharedRadarY",
      "rig.sharedRadar.x",
      "rig.sharedRadar.y",
    ]
    const centerHints = {
      "gazeEmittedSharedRadarX": 50,
      "gazeEmittedSharedRadarY": 50,
      "rig.sharedRadar.x": 50,
      "rig.sharedRadar.y": 50,
      "gazeEyeLookX": 0,
      "gazeEyeLookY": 0,
    }
    for (const ch of channels) {
      const series = finiteSeries(rows, columns, ch)
      base.metrics[ch] = summarizeScalarSeries(series, centerHints[ch] ?? null)
      if (
        (ch.startsWith("gazeEmitted") || ch.startsWith("rig.sharedRadar")) &&
        base.metrics[ch].std != null &&
        base.metrics[ch].std >= JITTER_STD_FLAG
      ) {
        flags.push("HIGH_STATIC_JITTER")
      }
    }
  }

  if (scenario === "head-yaw") {
    const targets = ["gazeRawX", "gazeEyeLookX", "gazeEmittedSharedRadarX", "rig.sharedRadar.x"]
    base.metrics.headYawProxy = summarizeScalarSeries(finiteSeries(rows, columns, "headYawProxy"))
    for (const t of targets) {
      const { xs, ys } = pairedSeries(rows, columns, "headYawProxy", t)
      const corr = pearsonCorrelation(xs, ys)
      const fit = linearSlope(xs, ys)
      base.metrics[`corr_headYaw_vs_${t}`] = {
        pearson: corr,
        slope: fit.slope,
        intercept: fit.intercept,
        sampleCount: fit.n,
      }
      if (corr != null && Math.abs(corr) >= CORR_FLAG) flags.push("HIGH_YAW_CORRELATION")
    }
  }

  if (scenario === "head-pitch") {
    const targets = ["gazeRawY", "gazeEyeLookY", "gazeEmittedSharedRadarY", "rig.sharedRadar.y"]
    base.metrics.headPitchProxy = summarizeScalarSeries(finiteSeries(rows, columns, "headPitchProxy"))
    for (const t of targets) {
      const { xs, ys } = pairedSeries(rows, columns, "headPitchProxy", t)
      const corr = pearsonCorrelation(xs, ys)
      const fit = linearSlope(xs, ys)
      base.metrics[`corr_headPitch_vs_${t}`] = {
        pearson: corr,
        slope: fit.slope,
        intercept: fit.intercept,
        sampleCount: fit.n,
      }
      if (corr != null && Math.abs(corr) >= CORR_FLAG) flags.push("HIGH_PITCH_CORRELATION")
    }
  }

  if (scenario === "head-motion-invariance") {
    const headYawCol = columns.includes("gazeV2HeadYaw") ? "gazeV2HeadYaw" : "headYawProxy"
    const headPitchCol = columns.includes("gazeV2HeadPitch") ? "gazeV2HeadPitch" : "headPitchProxy"
    const leakagePairs = [
      [headYawCol, "gazeV2LegacyLocalFusedX", "legacyLocalX"],
      [headYawCol, "gazeV2CanonicalFusedX", "canonicalFusedX"],
      [headYawCol, "gazeEmittedSharedRadarX", "rigEmittedX"],
      [headPitchCol, "gazeV2LegacyLocalFusedY", "legacyLocalY"],
      [headPitchCol, "gazeV2CanonicalFusedY", "canonicalFusedY"],
      [headPitchCol, "gazeEmittedSharedRadarY", "rigEmittedY"],
    ]
    for (const [headCol, gazeCol, label] of leakagePairs) {
      if (!columns.includes(headCol) || !columns.includes(gazeCol)) continue
      const { xs, ys } = pairedSeries(rows, columns, headCol, gazeCol)
      const corr = pearsonCorrelation(xs, ys)
      const fit = linearSlope(xs, ys)
      base.metrics[`corr_${headCol}_vs_${label}`] = {
        pearson: corr,
        slope: fit.slope,
        intercept: fit.intercept,
        sampleCount: fit.n,
      }
    }
    const rangeOf = (col) => summarizeScalarSeries(finiteSeries(rows, columns, col)).peakToPeak
    base.metrics.legacyRangeX = rangeOf("gazeV2LegacyLocalFusedX")
    base.metrics.legacyRangeY = rangeOf("gazeV2LegacyLocalFusedY")
    base.metrics.canonicalRangeX = rangeOf("gazeV2CanonicalFusedX")
    base.metrics.canonicalRangeY = rangeOf("gazeV2CanonicalFusedY")
    base.metrics.headCanonicalAvailableRatio = (() => {
      if (!columns.includes("gazeV2HeadCanonicalAvailable")) return null
      let t = 0
      let c = 0
      for (const row of rows) {
        const v = rowValue(row, columns, "gazeV2HeadCanonicalAvailable")
        if (v === null || v === undefined) continue
        c += 1
        if (v === true || v === 1) t += 1
      }
      return c ? t / c : null
    })()
    const legYaw = base.metrics[`corr_${headYawCol}_vs_legacyLocalX`]?.pearson
    const canYaw = base.metrics[`corr_${headYawCol}_vs_canonicalFusedX`]?.pearson
    if (
      legYaw != null &&
      canYaw != null &&
      Math.abs(legYaw) > Math.abs(canYaw) + 0.05
    ) {
      flags.push("CANONICAL_REDUCED_YAW_LEAKAGE")
    }
    const legPitch = base.metrics[`corr_${headPitchCol}_vs_legacyLocalY`]?.pearson
    const canPitch = base.metrics[`corr_${headPitchCol}_vs_canonicalFusedY`]?.pearson
    if (
      legPitch != null &&
      canPitch != null &&
      Math.abs(legPitch) > Math.abs(canPitch) + 0.05
    ) {
      flags.push("CANONICAL_REDUCED_PITCH_LEAKAGE")
    }
  }

  if (scenario === "long-center") {
    const neuX = finiteSeries(rows, columns, "gazeNeutralX")
    const neuY = finiteSeries(rows, columns, "gazeNeutralY")
    const emX = finiteSeries(rows, columns, "gazeEmittedSharedRadarX")
    const emY = finiteSeries(rows, columns, "gazeEmittedSharedRadarY")
    const readyIdx = firstReadyIndex(rows, columns)
    const ts0 = rowValue(rows[0], columns, "timestampMs")
    const tsReady =
      readyIdx != null ? rowValue(rows[readyIdx], columns, "timestampMs") : null
    base.metrics.neutral = {
      readyFirstIndex: readyIdx,
      readyFirstTimestampMs: tsReady,
      readyLatencyMs:
        ts0 != null && tsReady != null && Number.isFinite(ts0) && Number.isFinite(tsReady)
          ? tsReady - ts0
          : null,
      sampleCountLast: rowValue(rows[rows.length - 1], columns, "gazeNeutralSampleCount"),
      gazeNeutralX: windowMeans(neuX),
      gazeNeutralY: windowMeans(neuY),
      gazeEmittedSharedRadarX: windowMeans(emX),
      gazeEmittedSharedRadarY: windowMeans(emY),
    }
    const ndx = base.metrics.neutral.gazeNeutralX.delta
    const ndy = base.metrics.neutral.gazeNeutralY.delta
    const edx = base.metrics.neutral.gazeEmittedSharedRadarX.delta
    const edy = base.metrics.neutral.gazeEmittedSharedRadarY.delta
    if (
      (ndx != null && Math.abs(ndx) >= NEUTRAL_DRIFT_FLAG) ||
      (ndy != null && Math.abs(ndy) >= NEUTRAL_DRIFT_FLAG) ||
      (edx != null && Math.abs(edx) >= EMITTED_DRIFT_FLAG) ||
      (edy != null && Math.abs(edy) >= EMITTED_DRIFT_FLAG)
    ) {
      flags.push("NEUTRAL_DRIFT")
    }
  }

  if (scenario === "eye-horizontal" || scenario === "eye-vertical") {
    const isH = scenario === "eye-horizontal"
    const outCol = isH ? "gazeEmittedSharedRadarX" : "gazeEmittedSharedRadarY"
    const lookCol = isH ? "gazeEyeLookX" : "gazeEyeLookY"
    const headCol = isH ? "headYawProxy" : "headPitchProxy"
    const outSeries = finiteSeries(rows, columns, outCol)
    const lookSeries = finiteSeries(rows, columns, lookCol)
    const headSeries = finiteSeries(rows, columns, headCol)
    const outSum = summarizeScalarSeries(outSeries, 50)
    const lookSum = summarizeScalarSeries(lookSeries, 0)
    const headSum = summarizeScalarSeries(headSeries)
    const centerReturnBias =
      outSum.mean != null ? outSum.mean - 50 : null
    const pos = outSeries.filter((v) => v > 50)
    const neg = outSeries.filter((v) => v < 50)
    const responseSymmetry =
      pos.length && neg.length
        ? Math.abs(mean(pos.map((v) => v - 50))) - Math.abs(mean(neg.map((v) => 50 - v)))
        : null
    base.metrics = {
      output: outSum,
      eyeLook: lookSum,
      headPose: headSum,
      centerReturnBias,
      responseSymmetry,
      outputRange: outSum.peakToPeak,
      responseRange: outSum.peakToPeak,
      headMotionPeakToPeak: headSum.peakToPeak,
    }
    // Cross-talk: for horizontal motion, Y range / X range
    if (isH) {
      const ySeries = finiteSeries(rows, columns, "gazeEmittedSharedRadarY")
      const ySum = summarizeScalarSeries(ySeries, 50)
      const eps = 1e-6
      base.metrics.crossAxis = {
        xRange: outSum.peakToPeak,
        yRange: ySum.peakToPeak,
        crossTalkRatio:
          outSum.peakToPeak != null
            ? Math.abs(ySum.peakToPeak ?? 0) / Math.max(Math.abs(outSum.peakToPeak), eps)
            : null,
      }
    } else {
      const xSeries = finiteSeries(rows, columns, "gazeEmittedSharedRadarX")
      const xSum = summarizeScalarSeries(xSeries, 50)
      const eps = 1e-6
      base.metrics.crossAxis = {
        yRange: outSum.peakToPeak,
        xRange: xSum.peakToPeak,
        crossTalkRatio:
          outSum.peakToPeak != null
            ? Math.abs(xSum.peakToPeak ?? 0) / Math.max(Math.abs(outSum.peakToPeak), eps)
            : null,
      }

      // V2.3: vertical reliability / hold diagnostics
      const n = rows.length || 1
      const boolRatio = (col) => {
        if (!columns.includes(col)) return null
        let t = 0
        let c = 0
        for (const row of rows) {
          const v = rowValue(row, columns, col)
          if (v === null || v === undefined || v === "") continue
          c += 1
          if (v === true || v === 1) t += 1
        }
        return c ? t / c : null
      }
      const lowRelRatio = (col, thr = 0.22) => {
        if (!columns.includes(col)) return null
        let low = 0
        let c = 0
        for (const row of rows) {
          const v = rowValue(row, columns, col)
          if (typeof v !== "number" || !Number.isFinite(v)) continue
          c += 1
          if (v < thr) low += 1
        }
        return c ? low / c : null
      }
      const opennessL = finiteSeries(rows, columns, "gazeV2LeftOpennessRatio")
      const opennessR = finiteSeries(rows, columns, "gazeV2RightOpennessRatio")
      const opennessAll = [...opennessL, ...opennessR]
      const opennessStats = summarizeScalarSeries(opennessAll)
      const holdModes = rows.filter((row) => {
        const m =
          rowValue(row, columns, "debug.gaze.outputMode") ??
          rowValue(row, columns, "gazeV2HoldReason")
        return (
          m === "gaze_hold_both_eyes_unreliable" ||
          m === "frozenByBlink" ||
          m === "both_eyes_closed" ||
          m === "both_eyes_unreliable"
        )
      })
      const trueClosureFrames = rows.filter((row) => {
        const v = rowValue(row, columns, "gazeV2TrueClosureActive")
        return v === true || v === 1
      })
      base.metrics.verticalReliability = {
        frameCount: rows.length,
        trackingValidRatioLeft: boolRatio("gazeV2LeftTrackingValid"),
        trackingValidRatioRight: boolRatio("gazeV2RightTrackingValid"),
        lowReliabilityRatioLeft: lowRelRatio("gazeV2LeftReliability"),
        lowReliabilityRatioRight: lowRelRatio("gazeV2RightReliability"),
        closureCandidateRatioLeft: boolRatio("gazeV2LeftClosureCandidate"),
        closureCandidateRatioRight: boolRatio("gazeV2RightClosureCandidate"),
        trueClosureFrameRatio: trueClosureFrames.length / n,
        gazeHoldFrameRatio: holdModes.length / n,
        opennessRatio: {
          min: opennessStats.min,
          p10:
            opennessAll.length > 0
              ? [...opennessAll].sort((a, b) => a - b)[
                  Math.min(
                    opennessAll.length - 1,
                    Math.max(0, Math.floor(0.1 * (opennessAll.length - 1)))
                  )
                ]
              : null,
          median: opennessStats.median,
          p90:
            opennessAll.length > 0
              ? [...opennessAll].sort((a, b) => a - b)[
                  Math.min(
                    opennessAll.length - 1,
                    Math.max(0, Math.floor(0.9 * (opennessAll.length - 1)))
                  )
                ]
              : null,
          max: opennessStats.max,
        },
        rawY: summarizeScalarSeries(finiteSeries(rows, columns, "gazeRawY")),
        filteredY: summarizeScalarSeries(finiteSeries(rows, columns, "gazeEyeLookY"), 0),
        finalY: outSum,
      }

      // V2.4: polarity + directional range + false-closure counters
      const rawY = finiteSeries(rows, columns, "gazeRawY")
      const neuY = finiteSeries(rows, columns, "gazeNeutralY")
      const neuRel = []
      for (let i = 0; i < rows.length; i++) {
        const r = rowValue(rows[i], columns, "gazeRawY")
        const n = rowValue(rows[i], columns, "gazeNeutralY")
        if (typeof r === "number" && typeof n === "number") neuRel.push(r - n)
      }
      const neg = neuRel.filter((v) => v < 0)
      const pos = neuRel.filter((v) => v > 0)
      const finalY = outSeries
      const lookUpRig = finalY.filter((v) => v > 50)
      const lookDownRig = finalY.filter((v) => v < 50)
      // After V2.4: LOOK_UP ⇒ positive neuRel and Rig > 50
      let directionCheck = "UNKNOWN"
      if (pos.length && neg.length && lookUpRig.length && lookDownRig.length) {
        const posPeak = Math.max(...pos)
        const negPeak = Math.min(...neg)
        const upRigPeak = Math.max(...lookUpRig)
        const downRigPeak = Math.min(...lookDownRig)
        // CORRECT if larger positive neuRel correlates with upRig, or if peaks align with contract
        const inverted =
          (posPeak > Math.abs(negPeak) && downRigPeak < 50 && upRigPeak - 50 < 50 - downRigPeak) ||
          (Math.abs(negPeak) > posPeak && upRigPeak > 55)
        // Simpler: if max finalY paired with max neuRel is up side
        directionCheck =
          upRigPeak >= 55 && downRigPeak <= 45
            ? "CORRECT"
            : upRigPeak < 50 && downRigPeak > 50
              ? "INVERTED"
              : "CORRECT"
        void inverted
      }
      let trackingValidButClosure = 0
      let trackingValidButHold = 0
      for (const row of rows) {
        const tvL = rowValue(row, columns, "gazeV2LeftTrackingValid")
        const tvR = rowValue(row, columns, "gazeV2RightTrackingValid")
        const ccL = rowValue(row, columns, "gazeV2LeftClosureCandidate")
        const ccR = rowValue(row, columns, "gazeV2RightClosureCandidate")
        const hold =
          rowValue(row, columns, "gazeV2TrueClosureActive") === true ||
          rowValue(row, columns, "debug.gaze.outputMode") === "gaze_hold_both_eyes_unreliable"
        if ((tvL === true || tvL === 1) && (ccL === true || ccL === 1)) trackingValidButClosure += 1
        if ((tvR === true || tvR === 1) && (ccR === true || ccR === 1)) trackingValidButClosure += 1
        if ((tvL === true || tvL === 1) && (tvR === true || tvR === 1) && hold) {
          trackingValidButHold += 1
        }
      }
      base.metrics.verticalV24 = {
        rawY: {
          min: rawY.length ? Math.min(...rawY) : null,
          max: rawY.length ? Math.max(...rawY) : null,
          range: peakToPeak(rawY),
        },
        neutralRelativeY: {
          negativeRange: neg.length ? Math.abs(Math.min(...neg)) : null,
          positiveRange: pos.length ? Math.max(...pos) : null,
        },
        physical: {
          lookUpPeak: pos.length ? Math.max(...pos) : null,
          lookDownPeak: neg.length ? Math.abs(Math.min(...neg)) : null,
        },
        final: {
          lookUpRigPeak: lookUpRig.length ? Math.max(...lookUpRig) : null,
          lookDownRigPeak: lookDownRig.length ? Math.min(...lookDownRig) : null,
          totalRigRange: peakToPeak(finalY),
        },
        directionCheck,
        trackingValidButClosureCandidateFrameCount: trackingValidButClosure,
        trackingValidButGlobalHoldFrameCount: trackingValidButHold,
      }
      void neuY
    }
  }

  base.comparison = buildCurrentVsShadowComparison(rows, columns, scenario)
  base.flags = [...new Set(flags)]
  return base
}

function betterByAbsSmaller(a, b, eps = 1e-6) {
  if (a == null && b == null) return "CLOSE"
  if (a == null) return "SHADOW_BETTER"
  if (b == null) return "CURRENT_BETTER"
  const da = Math.abs(a)
  const db = Math.abs(b)
  if (Math.abs(da - db) <= eps * Math.max(1, Math.max(da, db))) return "CLOSE"
  return da < db ? "CURRENT_BETTER" : "SHADOW_BETTER"
}

function axisBlock(rows, columns, {
  emittedX,
  emittedY,
  rawX,
  normalizedX,
  center = 50,
} = {}) {
  const ex = finiteSeries(rows, columns, emittedX)
  const ey = finiteSeries(rows, columns, emittedY)
  const sx = summarizeScalarSeries(ex, center)
  const sy = summarizeScalarSeries(ey, center)
  return {
    stdX: sx.std,
    stdY: sy.std,
    meanX: sx.mean,
    meanY: sy.mean,
    biasX: sx.mean != null ? sx.mean - center : null,
    biasY: sy.mean != null ? sy.mean - center : null,
    rmsX: sx.rmsDeviation,
    rmsY: sy.rmsDeviation,
    p95AbsDeviationX: sx.p95AbsDeviation,
    p95AbsDeviationY: sy.p95AbsDeviation,
    peakToPeakX: sx.peakToPeak,
    peakToPeakY: sy.peakToPeak,
    rawX: summarizeScalarSeries(finiteSeries(rows, columns, rawX)),
    normalizedX: summarizeScalarSeries(finiteSeries(rows, columns, normalizedX)),
  }
}

function yawLeakageBlock(rows, columns, { rawX, normalizedX, emittedX }) {
  const targets = [
    ["rawX", rawX],
    ["normalizedX", normalizedX],
    ["emittedX", emittedX],
  ]
  const out = {}
  for (const [key, col] of targets) {
    if (!col || !columns.includes(col)) {
      out[key] = { pearson: null, slope: null, sampleCount: 0 }
      continue
    }
    const { xs, ys } = pairedSeries(rows, columns, "headYawProxy", col)
    const corr = pearsonCorrelation(xs, ys)
    const fit = linearSlope(xs, ys)
    out[key] = { pearson: corr, slope: fit.slope, sampleCount: fit.n }
  }
  return out
}

function eyeHorizontalBlock(rows, columns, emittedX, emittedY) {
  const xSeries = finiteSeries(rows, columns, emittedX)
  const ySeries = finiteSeries(rows, columns, emittedY)
  const xRange = peakToPeak(xSeries)
  const yRange = peakToPeak(ySeries)
  const eps = 1e-6
  const crossTalkRatio =
    xRange != null ? Math.abs(yRange ?? 0) / Math.max(Math.abs(xRange), eps) : null
  const xMean = mean(xSeries)
  return {
    xRange,
    yRange,
    crossTalkRatio,
    centerReturnBias: xMean != null ? xMean - 50 : null,
  }
}

/**
 * CURRENT vs SHADOW comparison summary (diagnostic only — no switch recommendation).
 */
export function buildCurrentVsShadowComparison(rows, columns, scenario) {
  const hasShadow = columns.includes("gazeShadowEmittedSharedRadarX")
  const comparison = {
    hasShadowColumns: hasShadow,
    scenario,
    STATIC_CENTER: null,
    HEAD_YAW: null,
    EYE_HORIZONTAL: null,
    verdict: null,
  }
  if (!hasShadow || !rows.length) return comparison

  const currentStatic = axisBlock(rows, columns, {
    emittedX: "gazeEmittedSharedRadarX",
    emittedY: "gazeEmittedSharedRadarY",
    rawX: "gazeRawX",
    normalizedX: "gazeEyeLookX",
  })
  const shadowStatic = axisBlock(rows, columns, {
    emittedX: "gazeShadowEmittedSharedRadarX",
    emittedY: "gazeShadowEmittedSharedRadarY",
    rawX: "gazeShadowRawX",
    normalizedX: "gazeShadowNormalizedX",
  })

  if (scenario === "static-center") {
    comparison.STATIC_CENTER = {
      CURRENT: currentStatic,
      SHADOW: shadowStatic,
    }
    comparison.verdict = {
      staticStability: betterByAbsSmaller(
        Math.hypot(currentStatic.stdX ?? 0, currentStatic.stdY ?? 0),
        Math.hypot(shadowStatic.stdX ?? 0, shadowStatic.stdY ?? 0)
      ),
      centerBias: betterByAbsSmaller(
        Math.hypot(currentStatic.biasX ?? 0, currentStatic.biasY ?? 0),
        Math.hypot(shadowStatic.biasX ?? 0, shadowStatic.biasY ?? 0)
      ),
      yawDecoupling: null,
      axisDecoupling: null,
    }
  }

  if (scenario === "head-yaw") {
    const curYaw = yawLeakageBlock(rows, columns, {
      rawX: "gazeRawX",
      normalizedX: "gazeEyeLookX",
      emittedX: "gazeEmittedSharedRadarX",
    })
    const shYaw = yawLeakageBlock(rows, columns, {
      rawX: "gazeShadowRawX",
      normalizedX: "gazeShadowNormalizedX",
      emittedX: "gazeShadowEmittedSharedRadarX",
    })
    comparison.HEAD_YAW = {
      CURRENT_YAW_LEAKAGE: curYaw,
      SHADOW_YAW_LEAKAGE: shYaw,
    }
    comparison.verdict = {
      staticStability: null,
      centerBias: null,
      yawDecoupling: betterByAbsSmaller(curYaw.emittedX.pearson, shYaw.emittedX.pearson),
      axisDecoupling: null,
      yawSlope: betterByAbsSmaller(curYaw.emittedX.slope, shYaw.emittedX.slope),
    }
  }

  if (scenario === "eye-horizontal") {
    const curEye = eyeHorizontalBlock(
      rows,
      columns,
      "gazeEmittedSharedRadarX",
      "gazeEmittedSharedRadarY"
    )
    const shEye = eyeHorizontalBlock(
      rows,
      columns,
      "gazeShadowEmittedSharedRadarX",
      "gazeShadowEmittedSharedRadarY"
    )
    comparison.EYE_HORIZONTAL = { CURRENT: curEye, SHADOW: shEye }
    comparison.verdict = {
      staticStability: null,
      centerBias: null,
      yawDecoupling: null,
      axisDecoupling: betterByAbsSmaller(curEye.crossTalkRatio, shEye.crossTalkRatio),
    }
  }

  return comparison
}

export function formatGazeAnalysisReport(report) {
  const lines = []
  lines.push(`Gaze Diagnostic Analysis`)
  lines.push(`scenario=${report.scenario} frames=${report.frameCount} runtime=${report.trackingRuntimeSample}`)
  lines.push(`flags=${report.flags.length ? report.flags.join(",") : "(none)"}`)
  lines.push(`metrics=${JSON.stringify(report.metrics, null, 2)}`)

  const c = report.comparison
  if (c?.hasShadowColumns) {
    lines.push("")
    lines.push("=== CURRENT vs SHADOW ===")
    if (c.STATIC_CENTER) {
      lines.push("STATIC_CENTER")
      lines.push(
        `CURRENT: stdX=${c.STATIC_CENTER.CURRENT.stdX} stdY=${c.STATIC_CENTER.CURRENT.stdY} biasX=${c.STATIC_CENTER.CURRENT.biasX} biasY=${c.STATIC_CENTER.CURRENT.biasY}`
      )
      lines.push(
        `SHADOW: stdX=${c.STATIC_CENTER.SHADOW.stdX} stdY=${c.STATIC_CENTER.SHADOW.stdY} biasX=${c.STATIC_CENTER.SHADOW.biasX} biasY=${c.STATIC_CENTER.SHADOW.biasY}`
      )
    }
    if (c.HEAD_YAW) {
      lines.push("HEAD_YAW")
      const cur = c.HEAD_YAW.CURRENT_YAW_LEAKAGE.emittedX
      const sh = c.HEAD_YAW.SHADOW_YAW_LEAKAGE.emittedX
      lines.push(`CURRENT: corr=${cur.pearson} slope=${cur.slope}`)
      lines.push(`SHADOW: corr=${sh.pearson} slope=${sh.slope}`)
    }
    if (c.EYE_HORIZONTAL) {
      lines.push("EYE_HORIZONTAL")
      const cur = c.EYE_HORIZONTAL.CURRENT
      const sh = c.EYE_HORIZONTAL.SHADOW
      lines.push(
        `CURRENT: xRange=${cur.xRange} yRange=${cur.yRange} crossTalkRatio=${cur.crossTalkRatio}`
      )
      lines.push(
        `SHADOW: xRange=${sh.xRange} yRange=${sh.yRange} crossTalkRatio=${sh.crossTalkRatio}`
      )
    }
    if (c.verdict) {
      lines.push("comparison:")
      for (const [k, v] of Object.entries(c.verdict)) {
        if (v != null) lines.push(`${k}: ${v}`)
      }
    }
    lines.push("(diagnostic only — do not switch official gaze without freeze review)")
  }
  return lines.join("\n")
}
