import { buildServoMovesFromLogicalPose } from "../../../core/faceDofMapper.js"
import { getServoConfig, logicalToActualPwm } from "../../../core/servoConfig.js"

/**
 * @deprecated 正式链路请使用 output/buildFinalServoOutputsFromBindings（面部绑定 → finalServoOutputs）。
 * 复用旧 PWM Device Drive 的 actualPwm 计算。
 * Bus 模式：遍历 logicalPose 全键，不因 configs.enabled=false 丢弃（遗留逻辑）。
 *
 * @param {Record<string, number>} logicalPose
 * @param {object[]} configs
 * @param {number} [timeMs]
 * @param {{ forBus?: boolean }} [options]
 */
export function buildFinalServoOutputs(logicalPose, configs, timeMs = 40, { forBus = false } = {}) {
  if (!logicalPose || typeof logicalPose !== "object") {
    return []
  }

  if (!forBus && Array.isArray(configs)) {
    const moves = buildServoMovesFromLogicalPose(logicalPose, configs, timeMs)
    if (moves.length > 0) {
      return moves.map((m) => ({
        servoIndex: m.servoId,
        servoId: m.servoId,
        logicalServoIndex: m.servoId,
        actualPwm: m.pwm,
        pwm: m.pwm,
        timeMs: m.timeMs,
      }))
    }
  }

  const outputs = []
  for (const [idStr, logical] of Object.entries(logicalPose)) {
    const sid = Number(idStr)
    if (!Number.isFinite(sid) || !Number.isFinite(Number(logical))) {
      continue
    }

    if (!forBus && Array.isArray(configs)) {
      const cfg = getServoConfig(configs, sid)
      if (cfg.enabled === false) {
        continue
      }
    }

    let actualPwm = Number(logical)
    if (Array.isArray(configs)) {
      const cfg = getServoConfig(configs, sid)
      if (cfg) {
        actualPwm = logicalToActualPwm(logical, cfg).actualPwm
      }
    }

    outputs.push({
      servoIndex: sid,
      servoId: sid,
      logicalServoIndex: sid,
      actualPwm,
      pwm: actualPwm,
      timeMs,
    })
  }

  return outputs
}
