import {
  CHANNEL_VALUE,
  CHANNEL_X,
  CHANNEL_Y,
  CHANNEL_LATERAL,
  normalizeBinding,
  normalizeControl,
  rangeForControlId,
} from "../../core/faceRigProfile.js"
import { legacyRouteIndexToBusActuatorId } from "./migrateBindingsLegacyIndexToBusActuatorIds.js"

/**
 * Face Rig 新结构（独立眼球 / 鼻子 / jaw.lateral / tongue 停用）profile 迁移。
 */
export const STRUCTURE_V3_BINDING_VERSION = "1"

export const NOSE_L_SERVO_ID = 26
export const NOSE_R_SERVO_ID = 27
export const JAW_LATERAL_SERVO_ID = 28

function ensureControl(controls, controlDef) {
  const id = controlDef.controlId
  const idx = controls.findIndex((c) => c.controlId === id)
  const normalized = normalizeControl(controlDef, controls.length)
  if (idx >= 0) {
    const prev = controls[idx]
    controls[idx] = normalizeControl(
      {
        ...prev,
        ...normalized,
        channels: { ...normalized.channels, ...prev.channels, ...normalized.channels },
        label: prev.label || normalized.label,
      },
      idx
    )
  } else {
    controls.push(normalized)
  }
}

function hasBinding(bindings, controlId, channel, servoId) {
  return bindings.some(
    (b) =>
      b.controlId === controlId &&
      b.channel === channel &&
      Number(b.servoId) === Number(servoId)
  )
}

function hasChannelBinding(bindings, controlId, channel) {
  return bindings.some(
    (b) => b?.controlId === controlId && b.channel === channel && b.enabled !== false
  )
}

function addBinding(bindings, controlId, channel, servoId) {
  /* 该通道已有任意舵机绑定时不注入默认号，避免覆盖用户手改映射（如 nose→12/13） */
  if (hasChannelBinding(bindings, controlId, channel)) return
  if (hasBinding(bindings, controlId, channel, servoId)) return
  const { neutral, pos, neg } = rangeForControlId(controlId)
  bindings.push(
    normalizeBinding({
      bindingId: `bind_struct_v3_${controlId}_${channel}_${servoId}`,
      controlId,
      channel,
      servoId,
      neutralPwm: neutral,
      positiveTargetPwm: pos,
      negativeTargetPwm: neg,
      weight: 1,
      enabled: true,
    })
  )
}

/**
 * 将旧 eye_xy 四路拆到 eye_l_xy / eye_r_xy；补鼻子与 jaw.lateral；停用 tongue。
 * @param {{ controls: object[], bindings: object[] }} profileSlice
 */
export function migrateStructureV3ControlsAndBindings(profileSlice) {
  const controls = Array.isArray(profileSlice.controls) ? [...profileSlice.controls] : []
  let bindings = Array.isArray(profileSlice.bindings) ? [...profileSlice.bindings] : []

  const s = () => ({ value: { mode: "signed100" } })
  const xy = () => ({ x: { mode: "percent" }, y: { mode: "percent" } })
  const jawCh = () => ({
    value: { mode: "signed100" },
    lateral: { mode: "signed50", rawMin: -50, rawMax: 50 },
  })

  ensureControl(controls, { controlId: "eye_l_xy", label: "左眼球 XY", channels: xy() })
  ensureControl(controls, { controlId: "eye_r_xy", label: "右眼球 XY", channels: xy() })
  ensureControl(controls, { controlId: "nose_l", label: "鼻 · 左", channels: s() })
  ensureControl(controls, { controlId: "nose_r", label: "鼻 · 右", channels: s() })
  ensureControl(controls, { controlId: "jaw", label: "下颌", channels: jawCh() })
  // tongue 保留 control 定义以便旧数据可读，但不作为新结构主控
  ensureControl(controls, { controlId: "tongue", label: "舌（已停用）", channels: s() })

  // 旧 eye_xy → 左右拆分（按舵机：10/12 偏左，11/13 偏右；若无法区分则两侧各复制）
  const eyeXy = bindings.filter((b) => b.controlId === "eye_xy")
  if (eyeXy.length && !bindings.some((b) => b.controlId === "eye_l_xy" || b.controlId === "eye_r_xy")) {
    for (const b of eyeXy) {
      const sid = Number(b.servoId)
      const toLeft = sid === legacyRouteIndexToBusActuatorId(10) || sid === legacyRouteIndexToBusActuatorId(12)
      const toRight = sid === legacyRouteIndexToBusActuatorId(11) || sid === legacyRouteIndexToBusActuatorId(13)
      const targets = []
      if (toLeft || (!toLeft && !toRight)) targets.push("eye_l_xy")
      if (toRight || (!toLeft && !toRight)) targets.push("eye_r_xy")
      for (const controlId of targets) {
        bindings.push(
          normalizeBinding({
            ...b,
            bindingId: `bind_mig_${controlId}_${b.channel}_${sid}`,
            controlId,
            enabled: b.enabled !== false,
          })
        )
      }
    }
  }

  // 禁用旧 eye_xy / tongue 输出
  bindings = bindings.map((b) => {
    if (b.controlId === "eye_xy" || b.controlId === "tongue") {
      return normalizeBinding({ ...b, enabled: false })
    }
    return b
  })

  addBinding(bindings, "nose_l", CHANNEL_VALUE, NOSE_L_SERVO_ID)
  addBinding(bindings, "nose_r", CHANNEL_VALUE, NOSE_R_SERVO_ID)
  addBinding(bindings, "jaw", CHANNEL_LATERAL, JAW_LATERAL_SERVO_ID)

  // 若尚无左右眼球绑定，用 bus 10–13 补齐（不经 legacy route 10→11，避免左右冲突）
  if (!bindings.some((b) => b.controlId === "eye_l_xy" && b.enabled)) {
    addBinding(bindings, "eye_l_xy", CHANNEL_X, 10)
    addBinding(bindings, "eye_l_xy", CHANNEL_Y, 12)
  }
  if (!bindings.some((b) => b.controlId === "eye_r_xy" && b.enabled)) {
    addBinding(bindings, "eye_r_xy", CHANNEL_X, 11)
    addBinding(bindings, "eye_r_xy", CHANNEL_Y, 13)
  }

  return { controls, bindings }
}

export function profileNeedsStructureV3Patch(profile) {
  if (!profile || profile.structureV3BindingVersion === STRUCTURE_V3_BINDING_VERSION) {
    return false
  }
  return true
}
