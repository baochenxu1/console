import { reconcileBindingActuatorFields } from "../sdk/binding/bindingActuatorFields.js"
import { legacyServoIndexToActuatorKey } from "../sdk/output/actuatorKeys.js"
import {
  LEFT_EYE_LID_BINDING_TARGETS,
  LEFT_EYE_LID_BINDING_VERSION,
  patchLeftEyeLidBindings,
} from "../sdk/binding/leftEyeLidBindingDefaults.js"
import {
  JAW_SECONDARY_BINDING_VERSION,
  patchJawSecondaryBindings,
} from "../sdk/binding/jawSecondaryBindingDefaults.js"
import {
  JAW_NODE_BINDING_VERSION,
  JAW_A_DEFAULT_SERVO_ID,
  JAW_D_DEFAULT_SERVO_ID,
  ensureJawNodeControls,
  migrateJawNodeBindings,
  profileNeedsJawNodeBindingPatch,
} from "../sdk/binding/jawNodeBindingDefaults.js"
import {
  BINDING_DEDUPE_VERSION,
  dedupeBindingsByControlChannelActuator,
} from "../sdk/binding/dedupeBindings.js"
import {
  BINDING_BUS_ACTUATOR_VERSION,
  legacyRouteIndexToBusActuatorId,
  migrateBindingsLegacyIndexToBusActuatorIds,
  profileUsesLegacyRouteServoIndexing,
} from "../sdk/binding/migrateBindingsLegacyIndexToBusActuatorIds.js"
import {
  BROW_TIP_DUAL_BINDING_VERSION,
  BROW_L_F_SERVO_ID,
  BROW_L_D_SERVO_ID,
  BROW_R_F_SERVO_ID,
  BROW_R_D_SERVO_ID,
  ensureBrowTipIndependentDofControls,
  migrateBrowTipIndependentDof,
  patchBrowTipIndependentDofBindings,
  profileNeedsBrowTipDualBindingPatch,
} from "../sdk/binding/browTipDualBindingDefaults.js"
import {
  STRUCTURE_V3_BINDING_VERSION,
  migrateStructureV3ControlsAndBindings,
  profileNeedsStructureV3Patch,
} from "../sdk/binding/structureV3Migration.js"
import { clampNumber, toInt } from "../utils/clamp.js"
import { readJsonStorage, writeJsonStorage } from "../utils/storage.js"
import { sanitizeExpressionExportBasename, getDateTimeText } from "../utils/fileExport.js"
import {
  SERVO_COUNT,
  STANDARD_CENTER_PWM,
  SERVO_LOGICAL_MIN_PWM,
  SERVO_LOGICAL_MAX_PWM,
} from "./servoConfig.js"

export const FACE_RIG_PROFILE_VERSION = "3.2.0"
export const FACE_RIG_STORAGE_KEY = "servo-face-console:face-rig-profile"
export const FACE_RIG_PROFILE_CHANGED_EVENT = "facedev:faceRigProfileChanged"
export const FACE_RIG_EXPORT_TYPE = "robot-face-rig-profile"

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const CHANNEL_VALUE = "value"
export const CHANNEL_X = "x"
export const CHANNEL_Y = "y"
/** Jaw Left/Right（signed50，中位 0，满行程 ±50） */
export const CHANNEL_LATERAL = "lateral"

export const CURVE_LINEAR = "linear"
export const CURVE_SMOOTHSTEP = "smoothstep"

/** 绑定行程：未满量程则由引擎按方向拉伸到逻辑 500/2500；custom 则用当前正负目标 */
export const BINDING_RANGE_MODE_FULL = "full"
export const BINDING_RANGE_MODE_CUSTOM = "custom"

/** 控件通道：默认不限幅；仅在 JSON 中设置 rawMin/rawMax 时按比例映射前限制原始值 */
export function normalizeChannelSpec(raw = {}) {
  const mode = String(raw.mode || "signed100")
  const lo = Number(raw.rawMin)
  const hi = Number(raw.rawMax)
  return {
    mode,
    ...(Number.isFinite(lo) ? { rawMin: lo } : {}),
    ...(Number.isFinite(hi) ? { rawMax: hi } : {}),
  }
}

export function normalizeControl(raw = {}, index = 0) {
  const controlId = String(raw.controlId || raw.id || `ctrl_${index}`)
  const channels = {}
  const chRaw = raw.channels && typeof raw.channels === "object" ? raw.channels : {}

  if (chRaw.value !== undefined) {
    channels.value = normalizeChannelSpec(chRaw.value)
  }
  if (chRaw.x !== undefined) {
    channels.x = normalizeChannelSpec(chRaw.x)
  }
  if (chRaw.y !== undefined) {
    channels.y = normalizeChannelSpec(chRaw.y)
  }
  if (chRaw.lateral !== undefined) {
    channels.lateral = normalizeChannelSpec(chRaw.lateral)
  }

  return {
    controlId,
    label: String(raw.label || controlId),
    channels,
  }
}

/**
 * 从中性及各端点方向推导「满逻辑行程」端点（500/2500），保留正负驱动朝向。
 */
export function expandLogicalStrokeToFull(neutralPwm, positiveTargetPwm, negativeTargetPwm) {
  const n = clampNumber(
    neutralPwm,
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )
  const lo = SERVO_LOGICAL_MIN_PWM
  const hi = SERVO_LOGICAL_MAX_PWM
  const ps = clampNumber(positiveTargetPwm, lo, hi)
  const ng = clampNumber(negativeTargetPwm, lo, hi)

  let posEff
  if (ps > n) posEff = hi
  else if (ps < n) posEff = lo
  else posEff = ng <= n ? hi : lo

  let negEff
  if (ng < n) negEff = lo
  else if (ng > n) negEff = hi
  else negEff = ps >= n ? lo : hi

  if (posEff === negEff) {
    negEff = posEff === hi ? lo : hi
  }

  return {
    neutralPwm: n,
    positiveTargetPwm: clampNumber(posEff, lo, hi),
    negativeTargetPwm: clampNumber(negEff, lo, hi),
  }
}

/**
 * 正负目标相同时无法区分控件方向；拆到中性两侧满行程。
 * @returns {{ positiveTargetPwm: number, negativeTargetPwm: number, repaired: boolean }}
 */
export function repairCollapsedBindingTargets(neutralPwm, positiveTargetPwm, negativeTargetPwm) {
  const lo = SERVO_LOGICAL_MIN_PWM
  const hi = SERVO_LOGICAL_MAX_PWM
  const pos = clampNumber(positiveTargetPwm, lo, hi)
  const neg = clampNumber(negativeTargetPwm, lo, hi)
  if (pos !== neg) {
    return { positiveTargetPwm: pos, negativeTargetPwm: neg, repaired: false }
  }
  const n = clampNumber(neutralPwm, lo, hi)
  if (pos >= n) {
    return { positiveTargetPwm: hi, negativeTargetPwm: lo, repaired: true }
  }
  return { positiveTargetPwm: lo, negativeTargetPwm: hi, repaired: true }
}

/**
 * 「恢复全范围」按存储端点与中性比较：`>=中性 → 2500`，否则 `500`。用于检视器一键拉回逻辑极值并保持朝向。
 */
export function bindingWithRestoredEndpointsVsNeutral(binding) {
  const lo = SERVO_LOGICAL_MIN_PWM
  const hi = SERVO_LOGICAL_MAX_PWM
  const n = clampNumber(binding.neutralPwm, lo, hi)
  let nextPos = binding.positiveTargetPwm >= n ? hi : lo
  let nextNeg = binding.negativeTargetPwm >= n ? hi : lo
  const repaired = repairCollapsedBindingTargets(n, nextPos, nextNeg)
  nextPos = repaired.positiveTargetPwm
  nextNeg = repaired.negativeTargetPwm
  return normalizeBinding({
    ...binding,
    positiveTargetPwm: nextPos,
    negativeTargetPwm: nextNeg,
    rangeMode: BINDING_RANGE_MODE_FULL,
  })
}

/**
 * 绑定正反向：绕中位镜像 logical PWM。与行程端点独立，保存到 profile.invert。
 */
export function applyBindingInvertToPwm(pwm, binding) {
  if (!binding?.invert) {
    return pwm
  }
  const n = Number(binding.neutralPwm)
  const n0 = Number.isFinite(n) ? n : STANDARD_CENTER_PWM
  return clampNumber(
    Math.round(n0 - (Number(pwm) - n0)),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )
}

/** 运行时求参与 evaluate 的有效端点（full 不占位 custom 则用存储值）。 */
export function resolveBindingTargetsForEvaluate(binding) {
  const rm = binding.rangeMode || BINDING_RANGE_MODE_FULL
  const n = binding.neutralPwm
  let positiveTargetPwm
  let negativeTargetPwm

  if (rm === BINDING_RANGE_MODE_CUSTOM) {
    positiveTargetPwm = binding.positiveTargetPwm
    negativeTargetPwm = binding.negativeTargetPwm
  } else {
    const e = expandLogicalStrokeToFull(
      binding.neutralPwm,
      binding.positiveTargetPwm,
      binding.negativeTargetPwm
    )
    positiveTargetPwm = e.positiveTargetPwm
    negativeTargetPwm = e.negativeTargetPwm
  }

  const repaired = repairCollapsedBindingTargets(n, positiveTargetPwm, negativeTargetPwm)
  return {
    neutralPwm: n,
    positiveTargetPwm: repaired.positiveTargetPwm,
    negativeTargetPwm: repaired.negativeTargetPwm,
  }
}

/** custom 模式下相对满行程的近似利用率（%），两端取更小值。full 视作 100。 */
export function bindingStrokeUtilizationPercent(binding) {
  if ((binding.rangeMode || BINDING_RANGE_MODE_FULL) !== BINDING_RANGE_MODE_CUSTOM) {
    return 100
  }

  const n = binding.neutralPwm
  const lo = SERVO_LOGICAL_MIN_PWM
  const hi = SERVO_LOGICAL_MAX_PWM

  let idealTowardPosDriver = binding.positiveTargetPwm >= n ? hi - n : n - lo
  let idealTowardNegDriver = binding.negativeTargetPwm <= n ? n - lo : hi - n

  idealTowardPosDriver = Math.max(idealTowardPosDriver, 1e-9)
  idealTowardNegDriver = Math.max(idealTowardNegDriver, 1e-9)

  const usedPos = Math.abs(binding.positiveTargetPwm - n)
  const usedNeg = Math.abs(binding.negativeTargetPwm - n)

  const rp = usedPos / idealTowardPosDriver
  const rn = usedNeg / idealTowardNegDriver

  return clampNumber(Math.min(rp, rn) * 100, 0, 100)
}

export function normalizeBinding(raw = {}) {
  const actuatorFields = reconcileBindingActuatorFields(raw)
  const servoId = clampNumber(toInt(actuatorFields.servoId, 0), 0, Math.max(0, SERVO_COUNT - 1))
  const legacyServoIndex = clampNumber(
    toInt(actuatorFields.legacyServoIndex ?? servoId, servoId),
    0,
    Math.max(0, SERVO_COUNT - 1)
  )
  // 与 clamp 后的 servoId 强制对齐，避免 actuatorKey=servo_99 而 servoId=39 的错位
  const actuatorKey = legacyServoIndexToActuatorKey(servoId)

  let neutralPwm = clampNumber(
    toInt(raw.neutralPwm, STANDARD_CENTER_PWM),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )
  let positiveTargetPwm = clampNumber(
    toInt(raw.positiveTargetPwm, SERVO_LOGICAL_MAX_PWM),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )
  let negativeTargetPwm = clampNumber(
    toInt(raw.negativeTargetPwm, SERVO_LOGICAL_MIN_PWM),
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )

  const incomingMode = raw.rangeMode
  let rangeMode =
    incomingMode === BINDING_RANGE_MODE_CUSTOM || incomingMode === BINDING_RANGE_MODE_FULL
      ? incomingMode
      : BINDING_RANGE_MODE_FULL

  const hadIncomingRangeMode = incomingMode === BINDING_RANGE_MODE_CUSTOM || incomingMode === BINDING_RANGE_MODE_FULL

  if (!hadIncomingRangeMode) {
    rangeMode = BINDING_RANGE_MODE_FULL
    const e = expandLogicalStrokeToFull(neutralPwm, positiveTargetPwm, negativeTargetPwm)
    positiveTargetPwm = e.positiveTargetPwm
    negativeTargetPwm = e.negativeTargetPwm
  } else if (rangeMode === BINDING_RANGE_MODE_FULL) {
    const e = expandLogicalStrokeToFull(neutralPwm, positiveTargetPwm, negativeTargetPwm)
    positiveTargetPwm = e.positiveTargetPwm
    negativeTargetPwm = e.negativeTargetPwm
  }

  if (positiveTargetPwm === negativeTargetPwm) {
    const repaired = repairCollapsedBindingTargets(neutralPwm, positiveTargetPwm, negativeTargetPwm)
    positiveTargetPwm = repaired.positiveTargetPwm
    negativeTargetPwm = repaired.negativeTargetPwm
    rangeMode = BINDING_RANGE_MODE_CUSTOM
  }

  const invert = Boolean(raw.invert)

  return {
    bindingId: String(raw.bindingId || uid("bind")),
    controlId: String(raw.controlId || ""),
    channel: String(raw.channel || CHANNEL_VALUE),
    servoId,
    actuatorKey,
    legacyServoIndex,
    neutralPwm,
    positiveTargetPwm,
    negativeTargetPwm,
    invert,
    weight: clampNumber(Number(raw.weight ?? 1), 0, 4),
    curve: String(raw.curve || CURVE_LINEAR),
    enabled: raw.enabled !== false,
    rangeMode,
    ...(raw.disabledReason ? { disabledReason: String(raw.disabledReason) } : {}),
    ...(raw.migratedFromNeutralPwm != null
      ? { migratedFromNeutralPwm: toInt(raw.migratedFromNeutralPwm, STANDARD_CENTER_PWM) }
      : {}),
  }
}

/**
 * Bus Servo（installed_center）模式下：binding neutral 归一到 1500，保留相对正负行程。
 * 机械零点由 actuator profile 管理，binding 不应再承担零点补偿。
 */
export function normalizeBindingNeutralForBus(binding) {
  const oldNeutral = clampNumber(
    binding.neutralPwm ?? STANDARD_CENTER_PWM,
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )

  if (oldNeutral === STANDARD_CENTER_PWM) {
    return binding
  }

  const pos = clampNumber(
    binding.positiveTargetPwm ?? SERVO_LOGICAL_MAX_PWM,
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )
  const neg = clampNumber(
    binding.negativeTargetPwm ?? SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MIN_PWM,
    SERVO_LOGICAL_MAX_PWM
  )

  return normalizeBinding({
    ...binding,
    neutralPwm: STANDARD_CENTER_PWM,
    positiveTargetPwm: clampNumber(
      STANDARD_CENTER_PWM + (pos - oldNeutral),
      SERVO_LOGICAL_MIN_PWM,
      SERVO_LOGICAL_MAX_PWM
    ),
    negativeTargetPwm: clampNumber(
      STANDARD_CENTER_PWM + (neg - oldNeutral),
      SERVO_LOGICAL_MIN_PWM,
      SERVO_LOGICAL_MAX_PWM
    ),
    migratedFromNeutralPwm: oldNeutral,
    rangeMode: BINDING_RANGE_MODE_CUSTOM,
  })
}

export function createDefaultControls() {
  const s = () => ({ value: { mode: "signed100" } })
  const xy = () => ({
    x: { mode: "percent" },
    y: { mode: "percent" },
  })
  /** 眉尖语义目标：统一 signed100，中位 0（与 mid/tail / IK pad 一致） */
  const browTipXy = () => ({
    x: { mode: "signed100" },
    y: { mode: "signed100" },
  })

  return [
    { controlId: "brow_l_tip", label: "左眉 · 尖端目标 XY（近鼻）", channels: browTipXy() },
    { controlId: "brow_l_F", label: "左眉 · F 节点内侧轴（qF → ID24）", channels: s() },
    { controlId: "brow_l_D", label: "左眉 · D 节点外侧轴（qD → ID23）", channels: s() },
    { controlId: "brow_l_tip_a", label: "左眉 · tip_a（遗留别名 ≡ D / qD）", channels: s() },
    { controlId: "brow_l_tip_b", label: "左眉 · tip_b（遗留别名 ≡ F / qF）", channels: s() },
    { controlId: "brow_l_mid", label: "左眉 · 中段", channels: s() },
    { controlId: "brow_l_tail", label: "左眉 · 尾端（外侧）", channels: s() },
    { controlId: "brow_r_tip", label: "右眉 · 尖端目标 XY（近鼻）", channels: browTipXy() },
    { controlId: "brow_r_F", label: "右眉 · F 节点内侧轴（qF → ID1）", channels: s() },
    { controlId: "brow_r_D", label: "右眉 · D 节点外侧轴（qD → ID2）", channels: s() },
    { controlId: "brow_r_tip_a", label: "右眉 · tip_a（遗留别名 ≡ D / qD）", channels: s() },
    { controlId: "brow_r_tip_b", label: "右眉 · tip_b（遗留别名 ≡ F / qF）", channels: s() },
    { controlId: "brow_r_mid", label: "右眉 · 中段", channels: s() },
    { controlId: "brow_r_tail", label: "右眉 · 尾端（外侧）", channels: s() },
    { controlId: "eye_l_up", label: "左眼 · 上睑", channels: s() },
    { controlId: "eye_l_lo", label: "左眼 · 下睑", channels: s() },
    { controlId: "eye_r_up", label: "右眼 · 上睑", channels: s() },
    { controlId: "eye_r_lo", label: "右眼 · 下睑", channels: s() },
    { controlId: "eye_l_xy", label: "左眼球 XY", channels: xy() },
    { controlId: "eye_r_xy", label: "右眼球 XY", channels: xy() },
    { controlId: "nose_l", label: "鼻 · 左", channels: s() },
    { controlId: "nose_r", label: "鼻 · 右", channels: s() },
    { controlId: "mouth_ul", label: "嘴 · 左上", channels: s() },
    { controlId: "mouth_ur", label: "嘴 · 右上", channels: s() },
    { controlId: "mouth_ll", label: "嘴 · 左下", channels: s() },
    { controlId: "mouth_lr", label: "嘴 · 右下", channels: s() },
    { controlId: "mouth_corner_l", label: "嘴角 L", channels: xy() },
    { controlId: "mouth_corner_r", label: "嘴角 R", channels: xy() },
    { controlId: "tongue", label: "舌（已停用）", channels: s() },
    {
      controlId: "jaw",
      label: "下颌",
      channels: {
        value: { mode: "signed100" },
        lateral: { mode: "signed50", rawMin: -50, rawMax: 50 },
      },
    },
    { controlId: "jaw_A", label: "下颌 · A 节点（qA）", channels: s() },
    { controlId: "jaw_D", label: "下颌 · D 节点（qD）", channels: s() },
  ].map((c, i) => normalizeControl(c, i))
}

/**
 * 新建绑定默认：中性在中间，正/负行程覆盖逻辑脉宽全量（绑定内再限幅；与舵机配置的物理限位在 logicalToActualPwm 中处理）。
 * 旧版按控件区分的保守默认值已移除，避免 UI 满行程却到不了舵机逻辑极值。
 */
export function rangeForControlId(controlId) {
  const leftEye = LEFT_EYE_LID_BINDING_TARGETS[controlId]
  if (leftEye) {
    return {
      neutral: leftEye.neutralPwm,
      pos: leftEye.positiveTargetPwm,
      neg: leftEye.negativeTargetPwm,
    }
  }
  return {
    neutral: STANDARD_CENTER_PWM,
    pos: SERVO_LOGICAL_MAX_PWM,
    neg: SERVO_LOGICAL_MIN_PWM,
  }
}

/** 默认绑定：眉尖 DOF A/B 各一路、左右眼球独立、鼻子、jaw open+lateral；不含 tongue 输出。 */
export function createDefaultBindings() {
  /** @type {Array<[string, string, number | { busServoId: number }]>} */
  const rows = [
    ["brow_l_F", CHANNEL_VALUE, { busServoId: BROW_L_F_SERVO_ID }],
    ["brow_l_D", CHANNEL_VALUE, { busServoId: BROW_L_D_SERVO_ID }],
    ["brow_l_mid", CHANNEL_VALUE, 1],
    ["brow_l_tail", CHANNEL_VALUE, 2],
    ["brow_r_F", CHANNEL_VALUE, { busServoId: BROW_R_F_SERVO_ID }],
    ["brow_r_D", CHANNEL_VALUE, { busServoId: BROW_R_D_SERVO_ID }],
    ["brow_r_mid", CHANNEL_VALUE, 4],
    ["brow_r_tail", CHANNEL_VALUE, 5],
    ["eye_l_up", CHANNEL_VALUE, 6],
    ["eye_l_lo", CHANNEL_VALUE, 7],
    ["eye_r_up", CHANNEL_VALUE, 23],
    ["eye_r_lo", CHANNEL_VALUE, 9],
    // 眼球直接使用 bus 10–13，避免 legacy route 10→11 与右眼 X 冲突
    ["eye_l_xy", CHANNEL_X, { busServoId: 10 }],
    ["eye_l_xy", CHANNEL_Y, { busServoId: 12 }],
    ["eye_r_xy", CHANNEL_X, { busServoId: 11 }],
    ["eye_r_xy", CHANNEL_Y, { busServoId: 13 }],
    ["mouth_ul", CHANNEL_VALUE, 14],
    ["mouth_ur", CHANNEL_VALUE, 22],
    ["mouth_ll", CHANNEL_VALUE, 17],
    ["mouth_lr", CHANNEL_VALUE, 16],
    ["mouth_corner_l", CHANNEL_X, 18],
    ["mouth_corner_l", CHANNEL_Y, 19],
    ["mouth_corner_r", CHANNEL_X, 20],
    ["mouth_corner_r", CHANNEL_Y, 21],
    ["jaw_A", CHANNEL_VALUE, { busServoId: JAW_A_DEFAULT_SERVO_ID }],
    ["jaw_D", CHANNEL_VALUE, { busServoId: JAW_D_DEFAULT_SERVO_ID }],
  ]

  const bindings = rows.map(([controlId, channel, routeOrBus], i) => {
    const servoId =
      routeOrBus && typeof routeOrBus === "object" && Number.isFinite(Number(routeOrBus.busServoId))
        ? Number(routeOrBus.busServoId)
        : legacyRouteIndexToBusActuatorId(routeOrBus)
    const { neutral, pos, neg } = rangeForControlId(controlId)

    const leftEyeTargets = LEFT_EYE_LID_BINDING_TARGETS[controlId]
    return normalizeBinding({
      bindingId: `bind_elite_${i}_${servoId}`,
      controlId,
      channel,
      servoId,
      neutralPwm: neutral,
      positiveTargetPwm: pos,
      negativeTargetPwm: neg,
      weight: 1,
      curve: CURVE_LINEAR,
      enabled: true,
      rangeMode: leftEyeTargets ? BINDING_RANGE_MODE_CUSTOM : BINDING_RANGE_MODE_FULL,
      ...(leftEyeTargets || {}),
    })
  })

  return patchBrowTipIndependentDofBindings(
    migrateStructureV3ControlsAndBindings({
      controls: createDefaultControls(),
      bindings,
    }).bindings
  )
}

export function createDefaultFaceRigProfile() {
  return {
    version: FACE_RIG_PROFILE_VERSION,
    projectType: FACE_RIG_EXPORT_TYPE,
    name: "精英面部绑定",
    controls: createDefaultControls(),
    bindings: createDefaultBindings(),
    updatedAt: new Date().toISOString(),
  }
}

function migrateFromV1(raw) {
  return createDefaultFaceRigProfile()
}

export function normalizeFaceRigProfile(raw) {
  if (!raw || typeof raw !== "object") {
    return createDefaultFaceRigProfile()
  }

  const ver = String(raw.version || "")
  if (ver.startsWith("1.") || (Array.isArray(raw.dofDefs) && !Array.isArray(raw.controls))) {
    return migrateFromV1(raw)
  }

  const controlsRaw = Array.isArray(raw.controls) ? raw.controls : []
  let controls =
    controlsRaw.length > 0 ? controlsRaw.map((c, i) => normalizeControl(c, i)) : createDefaultControls()

  /** 显式传入 bindings 数组（含空数组）表示用户意图；缺省才灌默认绑定 */
  const bindingsProvided = Array.isArray(raw.bindings)
  /** 用户主动清空：迁移只升版本/改 controls，禁止 addBinding 回填 */
  const intentionalEmptyBindings = bindingsProvided && raw.bindings.length === 0
  let bindings = bindingsProvided
    ? raw.bindings.map(normalizeBinding).filter((b) => b.controlId)
    : createDefaultBindings()

  let bindingBusActuatorVersion = raw.bindingBusActuatorVersion
    ? String(raw.bindingBusActuatorVersion)
    : null

  if (
    !intentionalEmptyBindings &&
    bindingBusActuatorVersion !== BINDING_BUS_ACTUATOR_VERSION &&
    profileUsesLegacyRouteServoIndexing(bindings)
  ) {
    bindings = migrateBindingsLegacyIndexToBusActuatorIds(bindings)
    bindingBusActuatorVersion = BINDING_BUS_ACTUATOR_VERSION
  } else if (intentionalEmptyBindings && !bindingBusActuatorVersion) {
    bindingBusActuatorVersion = BINDING_BUS_ACTUATOR_VERSION
  }

  let structureV3BindingVersion = raw.structureV3BindingVersion
    ? String(raw.structureV3BindingVersion)
    : null
  if (profileNeedsStructureV3Patch({ ...raw, structureV3BindingVersion })) {
    const migrated = migrateStructureV3ControlsAndBindings({ controls, bindings })
    controls = migrated.controls
    bindings = intentionalEmptyBindings ? [] : migrated.bindings
    structureV3BindingVersion = STRUCTURE_V3_BINDING_VERSION
  }

  let browTipDualBindingVersion = raw.browTipDualBindingVersion
    ? String(raw.browTipDualBindingVersion)
    : null
  if (profileNeedsBrowTipDualBindingPatch({ ...raw, browTipDualBindingVersion })) {
    const migrated = migrateBrowTipIndependentDof({ controls, bindings })
    controls = migrated.controls.map((c, i) => normalizeControl(c, i))
    bindings = intentionalEmptyBindings ? [] : migrated.bindings
    browTipDualBindingVersion = BROW_TIP_DUAL_BINDING_VERSION
  } else {
    controls = ensureBrowTipIndependentDofControls(controls).map((c, i) => normalizeControl(c, i))
  }

  const controlIds = new Set(controls.map((c) => c.controlId))
  let filteredBindings = bindings.filter((b) => controlIds.has(b.controlId))

  let leftEyeLidBindingVersion = raw.leftEyeLidBindingVersion
    ? String(raw.leftEyeLidBindingVersion)
    : null
  if (leftEyeLidBindingVersion !== LEFT_EYE_LID_BINDING_VERSION) {
    if (!intentionalEmptyBindings) {
      filteredBindings = patchLeftEyeLidBindings(filteredBindings)
    }
    leftEyeLidBindingVersion = LEFT_EYE_LID_BINDING_VERSION
  }

  let jawSecondaryBindingVersion = raw.jawSecondaryBindingVersion
    ? String(raw.jawSecondaryBindingVersion)
    : null
  if (jawSecondaryBindingVersion !== JAW_SECONDARY_BINDING_VERSION) {
    if (!intentionalEmptyBindings) {
      filteredBindings = patchJawSecondaryBindings(filteredBindings)
    }
    jawSecondaryBindingVersion = JAW_SECONDARY_BINDING_VERSION
  }

  let jawNodeBindingVersion = raw.jawNodeBindingVersion
    ? String(raw.jawNodeBindingVersion)
    : null
  if (profileNeedsJawNodeBindingPatch({ ...raw, jawNodeBindingVersion })) {
    const migrated = migrateJawNodeBindings({ controls, bindings: filteredBindings })
    controls = migrated.controls.map((c, i) => normalizeControl(c, i))
    filteredBindings = intentionalEmptyBindings ? [] : migrated.bindings
    jawNodeBindingVersion = JAW_NODE_BINDING_VERSION
  } else {
    controls = ensureJawNodeControls(controls).map((c, i) => normalizeControl(c, i))
  }

  const controlIdsAfterJaw = new Set(controls.map((c) => c.controlId))
  filteredBindings = filteredBindings.filter((b) => controlIdsAfterJaw.has(b.controlId))

  let bindingDedupeVersion = raw.bindingDedupeVersion ? String(raw.bindingDedupeVersion) : null
  if (bindingDedupeVersion !== BINDING_DEDUPE_VERSION) {
    if (!intentionalEmptyBindings) {
      filteredBindings = dedupeBindingsByControlChannelActuator(filteredBindings).bindings
    }
    bindingDedupeVersion = BINDING_DEDUPE_VERSION
  }

  const ignoredControls = Array.isArray(raw.ignoredControls)
    ? raw.ignoredControls.map(String).filter((id) => controlIdsAfterJaw.has(id))
    : []

  return {
    version: FACE_RIG_PROFILE_VERSION,
    projectType: String(raw.projectType || FACE_RIG_EXPORT_TYPE),
    // Preserve empty string while editing; only fall back when field is absent.
    name: typeof raw.name === "string" ? raw.name : "面部绑定",
    controls,
    bindings: bindingsProvided ? filteredBindings : filteredBindings.length > 0 ? filteredBindings : createDefaultBindings(),
    ignoredControls,
    ...(raw.busSemanticsMigratedAt
      ? { busSemanticsMigratedAt: String(raw.busSemanticsMigratedAt) }
      : {}),
    ...(raw.busSemanticsVersion ? { busSemanticsVersion: String(raw.busSemanticsVersion) } : {}),
    ...(bindingBusActuatorVersion
      ? { bindingBusActuatorVersion }
      : {}),
    ...(leftEyeLidBindingVersion ? { leftEyeLidBindingVersion } : {}),
    ...(jawSecondaryBindingVersion ? { jawSecondaryBindingVersion } : {}),
    ...(jawNodeBindingVersion ? { jawNodeBindingVersion } : {}),
    ...(browTipDualBindingVersion ? { browTipDualBindingVersion } : {}),
    ...(structureV3BindingVersion ? { structureV3BindingVersion } : {}),
    ...(bindingDedupeVersion ? { bindingDedupeVersion } : {}),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
  }
}

export function loadFaceRigProfile() {
  const raw = readJsonStorage(FACE_RIG_STORAGE_KEY, null)
  return normalizeFaceRigProfile(raw)
}

export function saveFaceRigProfile(profile) {
  const normalized = normalizeFaceRigProfile(profile)
  const payload = {
    ...normalized,
    updatedAt: new Date().toISOString(),
  }
  writeJsonStorage(FACE_RIG_STORAGE_KEY, payload)
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(FACE_RIG_PROFILE_CHANGED_EVENT))
  }
  return payload
}

export function buildFaceRigExportPayload(profile) {
  const n = normalizeFaceRigProfile(profile)
  return {
    version: n.version,
    projectType: FACE_RIG_EXPORT_TYPE,
    name: n.name,
    controls: n.controls,
    bindings: n.bindings,
    ...(n.ignoredControls?.length ? { ignoredControls: n.ignoredControls } : {}),
    ...(n.busSemanticsMigratedAt ? { busSemanticsMigratedAt: n.busSemanticsMigratedAt } : {}),
    ...(n.busSemanticsVersion ? { busSemanticsVersion: n.busSemanticsVersion } : {}),
    ...(n.bindingBusActuatorVersion
      ? { bindingBusActuatorVersion: n.bindingBusActuatorVersion }
      : {}),
    ...(n.leftEyeLidBindingVersion
      ? { leftEyeLidBindingVersion: n.leftEyeLidBindingVersion }
      : {}),
    ...(n.jawSecondaryBindingVersion
      ? { jawSecondaryBindingVersion: n.jawSecondaryBindingVersion }
      : {}),
    ...(n.jawNodeBindingVersion ? { jawNodeBindingVersion: n.jawNodeBindingVersion } : {}),
    ...(n.browTipDualBindingVersion
      ? { browTipDualBindingVersion: n.browTipDualBindingVersion }
      : {}),
    ...(n.structureV3BindingVersion
      ? { structureV3BindingVersion: n.structureV3BindingVersion }
      : {}),
    ...(n.bindingDedupeVersion ? { bindingDedupeVersion: n.bindingDedupeVersion } : {}),
    exportedAt: new Date().toISOString(),
  }
}

export function buildFaceRigExportFilename(profileName) {
  const base = sanitizeExpressionExportBasename(profileName, "face-rig-profile")
  return `${base}_${getDateTimeText()}.json`
}

export function parseFaceRigImport(data) {
  if (typeof data === "string") {
    try {
      data = JSON.parse(data)
    } catch {
      return createDefaultFaceRigProfile()
    }
  }
  if (!data || typeof data !== "object") {
    return createDefaultFaceRigProfile()
  }
  if (data.projectType && data.projectType !== FACE_RIG_EXPORT_TYPE) {
    return normalizeFaceRigProfile(data)
  }
  return normalizeFaceRigProfile(data)
}
