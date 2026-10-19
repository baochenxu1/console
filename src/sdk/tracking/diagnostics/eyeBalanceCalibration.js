/**
 * Eye Balance Calibration（预留接口）：
 * 录制睁闭眼 → 统计 device close magnitude → 推荐左右 close gain。
 *
 * 输入为 Tracking Diagnostic frame（compact 或完整格式均可）。
 */

export const EYE_BALANCE_CALIBRATION_DEFAULTS = {
  blinkActiveThreshold: 25,
  minSamples: 5,
  gainMin: 0.45,
  gainMax: 1.6,
  /** 当前生效的 close gain（用于按比例换算推荐值） */
  currentGains: {
    leftUpperCloseGain: 1.0,
    leftLowerCloseGain: 1.0,
    rightUpperCloseGain: 1.0,
    rightLowerCloseGain: 1.0,
  },
}

const EPS = 1e-6

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clampGain(g, min, max) {
  return Math.max(min, Math.min(max, Number(g) || 1))
}

/**
 * @param {Partial<typeof EYE_BALANCE_CALIBRATION_DEFAULTS>} [options]
 */
export function createEyeBalanceCalibrationSession(options = {}) {
  const opts = {
    ...EYE_BALANCE_CALIBRATION_DEFAULTS,
    ...options,
    currentGains: {
      ...EYE_BALANCE_CALIBRATION_DEFAULTS.currentGains,
      ...(options.currentGains || {}),
    },
  }
  return {
    options: opts,
    startedAt: Date.now(),
    frameCount: 0,
    samples: {
      leftUpperCloseMag: [],
      rightUpperCloseMag: [],
      leftLowerCloseMag: [],
      rightLowerCloseMag: [],
    },
    warnings: [],
  }
}

function extractBlink(frame) {
  const blend = frame?.mediapipe?.blendshapes || {}
  const eb = frame?.mapping?.eyes?.eyeBalance?.blink
  if (eb) {
    return { blinkL: num(eb.blinkL), blinkR: num(eb.blinkR) }
  }
  // blendshapes 为 0~1，mapping blink 为 0~100；统一换算到 0~100
  return {
    blinkL: num(blend.eyeBlinkLeft) * 100,
    blinkR: num(blend.eyeBlinkRight) * 100,
  }
}

function extractCloseMags(frame) {
  const dev = frame?.mapping?.eyes?.eyeBalance?.device
  if (dev) {
    return {
      leftUpperCloseMag: num(dev.leftUpperCloseMag),
      rightUpperCloseMag: num(dev.rightUpperCloseMag),
      leftLowerCloseMag: num(dev.leftLowerCloseMag),
      rightLowerCloseMag: num(dev.rightLowerCloseMag),
    }
  }
  // fallback：直接从 binding.outputs + device.bus 计算
  const outputs = frame?.binding?.outputs || frame?.binding?.finalServoOutputs || []
  const bus = frame?.device?.bus || frame?.device?.busCommands || []
  const magFor = (controlId) => {
    const out = outputs.find((o) => o.sourceChannel === `${controlId}.value`)
    if (!out) return 0
    const cmd = bus.find((c) => c.actuatorKey === out.actuatorKey)
    const target = cmd?.targetPosition ?? out.pwmValue
    if (!Number.isFinite(Number(target))) return 0
    const center = Number(cmd?.installedCenterPosition) || 1500
    return Math.abs(Number(target) - center)
  }
  return {
    leftUpperCloseMag: magFor("eye_l_up"),
    rightUpperCloseMag: magFor("eye_r_up"),
    leftLowerCloseMag: magFor("eye_l_lo"),
    rightLowerCloseMag: magFor("eye_r_lo"),
  }
}

/**
 * 追加一帧诊断数据（仅在双眼 blink 活跃时采样 close magnitude）。
 * @param {ReturnType<typeof createEyeBalanceCalibrationSession>} session
 * @param {object} diagnosticFrame Tracking Diagnostic frame
 */
export function appendEyeBalanceCalibrationFrame(session, diagnosticFrame) {
  if (!session || !diagnosticFrame) {
    return session
  }
  session.frameCount += 1

  const { blinkL, blinkR } = extractBlink(diagnosticFrame)
  const thr = session.options.blinkActiveThreshold
  if (blinkL <= thr || blinkR <= thr) {
    return session
  }

  const mags = extractCloseMags(diagnosticFrame)
  session.samples.leftUpperCloseMag.push(mags.leftUpperCloseMag)
  session.samples.rightUpperCloseMag.push(mags.rightUpperCloseMag)
  session.samples.leftLowerCloseMag.push(mags.leftLowerCloseMag)
  session.samples.rightLowerCloseMag.push(mags.rightLowerCloseMag)
  return session
}

function avgOf(values) {
  if (!values.length) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * 结束会话，返回推荐 close gain。
 * @param {ReturnType<typeof createEyeBalanceCalibrationSession>} session
 * @returns {{ recommendedGains: object, stats: object, confidence: number, warnings: string[] }}
 */
export function finishEyeBalanceCalibrationSession(session) {
  const opts = session?.options || EYE_BALANCE_CALIBRATION_DEFAULTS
  const cur = opts.currentGains
  const warnings = [...(session?.warnings || [])]

  const s = session?.samples || {
    leftUpperCloseMag: [],
    rightUpperCloseMag: [],
    leftLowerCloseMag: [],
    rightLowerCloseMag: [],
  }
  const sampleCount = s.leftUpperCloseMag.length

  const stats = {
    leftUpperCloseMag: avgOf(s.leftUpperCloseMag),
    rightUpperCloseMag: avgOf(s.rightUpperCloseMag),
    leftLowerCloseMag: avgOf(s.leftLowerCloseMag),
    rightLowerCloseMag: avgOf(s.rightLowerCloseMag),
    sampleCount,
  }

  if (sampleCount < opts.minSamples) {
    warnings.push(
      `samples-insufficient: 闭眼采样帧 ${sampleCount} < ${opts.minSamples}，建议重新录制（保持正脸，连续睁闭眼 3 次）`
    )
    return {
      recommendedGains: { ...cur },
      stats,
      confidence: 0,
      warnings,
    }
  }

  const targetUpperMag = (stats.leftUpperCloseMag + stats.rightUpperCloseMag) / 2
  const targetLowerMag = (stats.leftLowerCloseMag + stats.rightLowerCloseMag) / 2

  const recommendedGains = {
    leftUpperCloseGain: clampGain(
      num(cur.leftUpperCloseGain, 1) * (targetUpperMag / Math.max(stats.leftUpperCloseMag, EPS)),
      opts.gainMin,
      opts.gainMax
    ),
    rightUpperCloseGain: clampGain(
      num(cur.rightUpperCloseGain, 1) * (targetUpperMag / Math.max(stats.rightUpperCloseMag, EPS)),
      opts.gainMin,
      opts.gainMax
    ),
    leftLowerCloseGain: clampGain(
      num(cur.leftLowerCloseGain, 1) * (targetLowerMag / Math.max(stats.leftLowerCloseMag, EPS)),
      opts.gainMin,
      opts.gainMax
    ),
    rightLowerCloseGain: clampGain(
      num(cur.rightLowerCloseGain, 1) * (targetLowerMag / Math.max(stats.rightLowerCloseMag, EPS)),
      opts.gainMin,
      opts.gainMax
    ),
  }

  // 置信度：样本量 + 左右幅度本身是否有效
  const magsValid =
    stats.leftUpperCloseMag > 5 &&
    stats.rightUpperCloseMag > 5 &&
    stats.leftLowerCloseMag > 5 &&
    stats.rightLowerCloseMag > 5
  if (!magsValid) {
    warnings.push("close-magnitude-too-small: 闭眼输出幅度过小，推荐值可能不可靠")
  }
  const sampleScore = Math.min(1, sampleCount / (opts.minSamples * 4))
  const confidence = magsValid ? Math.min(1, 0.4 + 0.6 * sampleScore) : 0.2 * sampleScore

  return {
    recommendedGains,
    stats,
    confidence,
    warnings,
  }
}

/**
 * 便捷函数：对已录制的 diagnostic frames 一次性计算推荐 gain。
 * @param {object[]} frames Tracking Diagnostic frames
 * @param {Partial<typeof EYE_BALANCE_CALIBRATION_DEFAULTS>} [options]
 */
export function calculateEyeBalanceFromFrames(frames, options = {}) {
  const session = createEyeBalanceCalibrationSession(options)
  for (const f of frames || []) {
    appendEyeBalanceCalibrationFrame(session, f)
  }
  return finishEyeBalanceCalibrationSession(session)
}
