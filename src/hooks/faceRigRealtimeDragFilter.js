/**
 * Face Binding 手动拖动：只下发与当前控件相关的执行器（对齐 Bus 滑条「单目标」跟手）。
 * 五杆 / 下颌等多执行器控件用 controlId 组展开。
 */

/**
 * @param {string | null | undefined} controlId
 * @returns {Set<string> | null} null = 不过滤（整脸）
 */
export function expandControlIdsForDrag(controlId) {
  if (controlId == null || controlId === "") return null
  const id = String(controlId)

  if (
    id === "brow_r_tip" ||
    id === "brow_r_F" ||
    id === "brow_r_D" ||
    id === "brow_r_tip_a" ||
    id === "brow_r_tip_b"
  ) {
    return new Set(["brow_r_tip", "brow_r_F", "brow_r_D", "brow_r_tip_a", "brow_r_tip_b"])
  }
  if (
    id === "brow_l_tip" ||
    id === "brow_l_F" ||
    id === "brow_l_D" ||
    id === "brow_l_tip_a" ||
    id === "brow_l_tip_b"
  ) {
    return new Set(["brow_l_tip", "brow_l_F", "brow_l_D", "brow_l_tip_a", "brow_l_tip_b"])
  }
  if (id === "jaw" || id === "jaw_A" || id === "jaw_D") {
    return new Set(["jaw", "jaw_A", "jaw_D"])
  }
  if (id === "mouth_corner_r") {
    return new Set(["mouth_corner_r", "mouth_ur", "mouth_lr"])
  }
  if (id === "mouth_corner_l") {
    return new Set(["mouth_corner_l", "mouth_ul", "mouth_ll"])
  }
  if (id === "eye_l_xy" || id === "eye_l_up" || id === "eye_l_lo") {
    return new Set(["eye_l_xy", "eye_l_up", "eye_l_lo"])
  }
  if (id === "eye_r_xy" || id === "eye_r_up" || id === "eye_r_lo") {
    return new Set(["eye_r_xy", "eye_r_up", "eye_r_lo"])
  }

  return new Set([id])
}

/**
 * @param {object[]} outputs
 * @param {Set<string> | null} controlIds
 * @returns {object[]}
 */
export function filterFinalOutputsByControlIds(outputs, controlIds) {
  if (!controlIds || controlIds.size === 0) {
    return Array.isArray(outputs) ? outputs : []
  }
  const list = Array.isArray(outputs) ? outputs : []
  const filtered = list.filter((o) => {
    const sc = String(o?.sourceChannel || "")
    const cid = sc.includes(".") ? sc.slice(0, sc.indexOf(".")) : sc
    if (cid && controlIds.has(cid)) return true
    const bid = String(o?.bindingId || "")
    if (bid && controlIds.has(bid)) return true
    return false
  })
  /* 过滤空则回退整脸，避免误配置导致完全不下发 */
  return filtered.length > 0 ? filtered : list
}

/**
 * 相对上次已发 PWM，只保留变化路（滑条同款「有变化才写」）。
 * @param {object[]} outputs
 * @param {Map<string, number>} lastSentByActuatorKey
 * @returns {object[]}
 */
export function filterFinalOutputsByPwmDelta(outputs, lastSentByActuatorKey) {
  const list = Array.isArray(outputs) ? outputs : []
  if (!(lastSentByActuatorKey instanceof Map) || lastSentByActuatorKey.size === 0) {
    return list
  }
  const changed = list.filter((o) => {
    const key = o?.actuatorKey != null ? String(o.actuatorKey) : `idx:${o?.legacyServoIndex}`
    const pwm = o?.pwmValue
    if (pwm == null || !Number.isFinite(Number(pwm))) return true
    const prev = lastSentByActuatorKey.get(key)
    return prev === undefined || Number(prev) !== Number(pwm)
  })
  return changed
}

/**
 * @param {Map<string, number>} map
 * @param {object[]} outputs
 */
export function rememberSentPwm(map, outputs) {
  if (!(map instanceof Map)) return
  for (const o of outputs || []) {
    const key = o?.actuatorKey != null ? String(o.actuatorKey) : `idx:${o?.legacyServoIndex}`
    if (o?.pwmValue != null && Number.isFinite(Number(o.pwmValue))) {
      map.set(key, Number(o.pwmValue))
    }
  }
}
