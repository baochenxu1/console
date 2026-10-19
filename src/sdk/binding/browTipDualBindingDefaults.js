import {
  CHANNEL_LATERAL,
  CHANNEL_VALUE,
  normalizeBinding,
  rangeForControlId,
} from "../../core/faceRigProfile.js"
import { legacyRouteIndexToBusActuatorId } from "./migrateBindingsLegacyIndexToBusActuatorIds.js"

/**
 * 眉尖 Independent DOF / Five-Bar：
 * UI 竖直/水平 → brow.y / brow.x（同一 2DOF 目标）；
 * solveBrowIK(x,y) → 节点角 → Binding。
 *
 * 右眉冻结节点：
 *   F = 内侧轴 = brow_r_F ← qF → 默认 ID1
 *   D = 外侧轴 = brow_r_D ← qD → 默认 ID2
 * 左眉冻结节点（与右眉对称）：
 *   F = 内侧轴 = brow_l_F ← qF → 默认 ID24
 *   D = 外侧轴 = brow_l_D ← qD → 默认 ID23
 * 兼容别名：tip_a ≡ D（qD），tip_b ≡ F（qF）。
 *
 * v1：双 value 绑在 brow_*_tip
 * v2：value + lateral 同控件
 * v3：tip_a/tip_b 独立线性绑定（错误解耦）
 * v4：brow_*_tip {x,y} percent 中位 50 + five-bar IK → tip_a/tip_b
 * v5：brow_*_tip {x,y} 统一 signed100 中位 0（与 mid/tail / IK pad 一致）
 * v6：误把两路舵机都绑在 tip_a 时，自动把第二路迁到 tip_b（否则 IK 永不就绪）
 * v7：右眉 brow_r_F / brow_r_D 正式节点 + 默认 ID1/ID2；tip_a/tip_b 降为别名
 * v8：废除横向→B/纵向→A；右眉 F/D 行程重置为标准满行程，不再继承 tip_* 历史 pos/neg/invert
 * v9：左眉 brow_l_F / brow_l_D 正式节点 + 默认 ID24/ID23；与右眉同一套 F/D 语义
 */
export const BROW_TIP_DUAL_BINDING_VERSION = "9"
/** @deprecated 与 {@link BROW_TIP_DUAL_BINDING_VERSION} 同义 */
export const BROW_TIP_INDEPENDENT_DOF_VERSION = BROW_TIP_DUAL_BINDING_VERSION

/** @deprecated 左眉次轴旧常量；现用 {@link BROW_L_F_SERVO_ID} */
export const BROW_L_TIP_SECONDARY_SERVO_ID = 24
export const BROW_R_TIP_SECONDARY_SERVO_ID = 25
export const BROW_L_TIP_B_SERVO_ID = BROW_L_TIP_SECONDARY_SERVO_ID
export const BROW_R_TIP_B_SERVO_ID = BROW_R_TIP_SECONDARY_SERVO_ID

/** 右眉冻结硬件：F=内侧 ID1，D=外侧 ID2 */
export const BROW_R_F_SERVO_ID = 1
export const BROW_R_D_SERVO_ID = 2

/** 左眉冻结硬件：F=内侧 ID24，D=外侧 ID23（与历史 tip_b/tip_a 真机一致） */
export const BROW_L_F_SERVO_ID = 24
export const BROW_L_D_SERVO_ID = 23

export const BROW_TIP_DOF_CONTROLS = Object.freeze({
  brow_l_tip: {
    label: "左眉 · 尖端目标 XY（近鼻）",
    kind: "semantic-xy",
  },
  /** 正式：左眉 F 节点（内侧轴）← qF */
  brow_l_F: {
    label: "左眉 · F 节点内侧轴（qF → ID24）",
    legacyTipId: "brow_l_tip",
    node: "F",
    servoId: BROW_L_F_SERVO_ID,
    legacyAliasOf: null,
  },
  /** 正式：左眉 D 节点（外侧轴）← qD */
  brow_l_D: {
    label: "左眉 · D 节点外侧轴（qD → ID23）",
    legacyTipId: "brow_l_tip",
    node: "D",
    servoId: BROW_L_D_SERVO_ID,
    legacyAliasOf: null,
  },
  /** @deprecated 别名 ≡ brow_l_D（历史上 tip_a ← qD） */
  brow_l_tip_a: {
    label: "左眉 · tip_a（遗留别名 ≡ D / qD）",
    legacyTipId: "brow_l_tip",
    node: "D",
    legacyAliasOf: "brow_l_D",
    primaryLegacyRoute: 0,
    servoId: BROW_L_D_SERVO_ID,
  },
  /** @deprecated 别名 ≡ brow_l_F（历史上 tip_b ← qF） */
  brow_l_tip_b: {
    label: "左眉 · tip_b（遗留别名 ≡ F / qF）",
    legacyTipId: "brow_l_tip",
    node: "F",
    legacyAliasOf: "brow_l_F",
    primaryLegacyRoute: null,
    servoId: BROW_L_F_SERVO_ID,
  },
  brow_r_tip: {
    label: "右眉 · 尖端目标 XY（近鼻）",
    kind: "semantic-xy",
  },
  /** 正式：右眉 F 节点（内侧轴）← qF */
  brow_r_F: {
    label: "右眉 · F 节点内侧轴（qF → ID1）",
    legacyTipId: "brow_r_tip",
    node: "F",
    servoId: BROW_R_F_SERVO_ID,
    legacyAliasOf: null,
  },
  /** 正式：右眉 D 节点（外侧轴）← qD */
  brow_r_D: {
    label: "右眉 · D 节点外侧轴（qD → ID2）",
    legacyTipId: "brow_r_tip",
    node: "D",
    servoId: BROW_R_D_SERVO_ID,
    legacyAliasOf: null,
  },
  /** @deprecated 别名 ≡ brow_r_D（历史上 tip_a ← qD） */
  brow_r_tip_a: {
    label: "右眉 · tip_a（遗留别名 ≡ D / qD）",
    legacyTipId: "brow_r_tip",
    node: "D",
    legacyAliasOf: "brow_r_D",
    primaryLegacyRoute: 3,
    servoId: BROW_R_D_SERVO_ID,
  },
  /** @deprecated 别名 ≡ brow_r_F（历史上 tip_b ← qF） */
  brow_r_tip_b: {
    label: "右眉 · tip_b（遗留别名 ≡ F / qF）",
    legacyTipId: "brow_r_tip",
    node: "F",
    legacyAliasOf: "brow_r_F",
    primaryLegacyRoute: null,
    servoId: BROW_R_F_SERVO_ID,
  },
})

const LEGACY_TIP_IDS = ["brow_l_tip", "brow_r_tip"]

function bindingKey(b) {
  return `${b?.controlId}|${b?.channel}|${Number(b?.servoId)}`
}

function resolveDofServoId(meta) {
  if (Number.isFinite(Number(meta.servoId))) return Number(meta.servoId)
  return legacyRouteIndexToBusActuatorId(meta.primaryLegacyRoute)
}

function makeDofBinding(controlId, servoId) {
  const { neutral, pos, neg } = rangeForControlId(controlId)
  return normalizeBinding({
    bindingId: `bind_brow_tip_dof_${controlId}_${servoId}`,
    controlId,
    channel: CHANNEL_VALUE,
    servoId,
    neutralPwm: neutral,
    positiveTargetPwm: pos,
    negativeTargetPwm: neg,
    weight: 1,
    enabled: true,
  })
}

function singleValueChannels() {
  return { value: { mode: "signed100" } }
}

function xyChannels() {
  return {
    x: { mode: "signed100" },
    y: { mode: "signed100" },
  }
}

/**
 * @deprecated v2 API：旧 tip 双通道；v4 起 semantic tip 用 xy，执行器 tip_a/tip_b 用 value。
 */
export function browTipControlChannels() {
  return xyChannels()
}

/**
 * 保证：semantic brow_*_tip {x,y} signed100 + 执行器通道。
 * 左右眉均保证 brow_*_F / brow_*_D。
 * @param {object[]} controls
 */
export function ensureBrowTipIndependentDofControls(controls) {
  let list = Array.isArray(controls) ? [...controls] : []

  for (const side of ["l", "r"]) {
    const semanticId = `brow_${side}_tip`
    const idF = `brow_${side}_F`
    const idD = `brow_${side}_D`
    const idA = `brow_${side}_tip_a`
    const idB = `brow_${side}_tip_b`
    const metaSem = BROW_TIP_DOF_CONTROLS[semanticId]
    const metaF = BROW_TIP_DOF_CONTROLS[idF]
    const metaD = BROW_TIP_DOF_CONTROLS[idD]
    const metaA = BROW_TIP_DOF_CONTROLS[idA]
    const metaB = BROW_TIP_DOF_CONTROLS[idB]

    const semIdx = list.findIndex((c) => c?.controlId === semanticId)
    if (semIdx >= 0) {
      const prev = list[semIdx]
      const hadOnlyValue =
        prev.channels?.value && !prev.channels?.x && !prev.channels?.y && !prev.channels?.lateral
      if (hadOnlyValue && !list.some((c) => c?.controlId === idA || c?.controlId === idF)) {
        list[semIdx] = {
          controlId: idF,
          label: metaF.label,
          channels: singleValueChannels(),
        }
        list.splice(semIdx, 0, {
          controlId: semanticId,
          label: metaSem.label,
          channels: xyChannels(),
        })
      } else {
        list[semIdx] = {
          ...prev,
          controlId: semanticId,
          label: prev.label || metaSem.label,
          channels: xyChannels(),
        }
      }
    } else {
      const midIdx = list.findIndex((c) => c?.controlId === `brow_${side}_mid`)
      const at = midIdx >= 0 ? midIdx : 0
      list.splice(at, 0, {
        controlId: semanticId,
        label: metaSem.label,
        channels: xyChannels(),
      })
    }

    const insertAfterSemantic = () => {
      const sIdx = list.findIndex((c) => c?.controlId === semanticId)
      return sIdx >= 0 ? sIdx + 1 : list.length
    }

    if (!list.some((c) => c?.controlId === idF)) {
      list.splice(insertAfterSemantic(), 0, {
        controlId: idF,
        label: metaF.label,
        channels: singleValueChannels(),
      })
    }
    if (!list.some((c) => c?.controlId === idD)) {
      const fIdx = list.findIndex((c) => c?.controlId === idF)
      list.splice(fIdx >= 0 ? fIdx + 1 : insertAfterSemantic(), 0, {
        controlId: idD,
        label: metaD.label,
        channels: singleValueChannels(),
      })
    }

    if (!list.some((c) => c?.controlId === idA)) {
      const dIdx = list.findIndex((c) => c?.controlId === idD)
      list.splice(dIdx >= 0 ? dIdx + 1 : insertAfterSemantic(), 0, {
        controlId: idA,
        label: metaA.label,
        channels: singleValueChannels(),
      })
    }
    if (!list.some((c) => c?.controlId === idB)) {
      const aIdx = list.findIndex((c) => c?.controlId === idA)
      list.splice(aIdx >= 0 ? aIdx + 1 : insertAfterSemantic(), 0, {
        controlId: idB,
        label: metaB.label,
        channels: singleValueChannels(),
      })
    }

    list = list.map((c) => {
      if (
        c?.controlId === idA ||
        c?.controlId === idB ||
        c?.controlId === idF ||
        c?.controlId === idD
      ) {
        const meta = BROW_TIP_DOF_CONTROLS[c.controlId]
        return {
          ...c,
          label: c.label || meta?.label || c.controlId,
          channels: { value: c.channels?.value || { mode: "signed100" } },
        }
      }
      if (c?.controlId === semanticId) {
        return {
          ...c,
          label: c.label || metaSem.label,
          channels: xyChannels(),
        }
      }
      return c
    })
  }

  return list
}

/** @deprecated 使用 {@link ensureBrowTipIndependentDofControls} */
export function ensureBrowTipControlChannels(controls) {
  return ensureBrowTipIndependentDofControls(controls)
}

/**
 * tip_a/tip_b → brow_*_D / brow_*_F，并冻结舵机号；行程重置为标准满行程。
 * @param {object[]} bindings
 * @param {"l"|"r"} side
 * @param {number} servoFId
 * @param {number} servoDId
 */
function migrateSideBrowFDBindings(bindings, side, servoFId, servoDId) {
  let list = Array.isArray(bindings) ? [...bindings] : []
  const idF = `brow_${side}_F`
  const idD = `brow_${side}_D`
  const idTipA = `brow_${side}_tip_a`
  const idTipB = `brow_${side}_tip_b`

  const takeValue = (controlId) =>
    list.find((b) => b?.controlId === controlId && b.channel === CHANNEL_VALUE && b.enabled !== false) ||
    null

  let bindF = takeValue(idF)
  let bindD = takeValue(idD)
  const tipA = takeValue(idTipA)
  const tipB = takeValue(idTipB)

  /* tip_b ≡ F，tip_a ≡ D */
  if (!bindF && tipB) {
    bindF = normalizeBinding({ ...tipB, controlId: idF, channel: CHANNEL_VALUE })
    list = list.filter((b) => b?.bindingId !== tipB.bindingId)
    list.push(bindF)
  }
  if (!bindD && tipA) {
    bindD = normalizeBinding({ ...tipA, controlId: idD, channel: CHANNEL_VALUE })
    list = list.filter((b) => b?.bindingId !== tipA.bindingId)
    list.push(bindD)
  }

  if (!takeValue(idF)) {
    list.push(makeDofBinding(idF, servoFId))
  }
  if (!takeValue(idD)) {
    list.push(makeDofBinding(idD, servoDId))
  }

  // 已是 F/D 的绑定：保留用户 servoId / 行程 / 极性。
  // 仅在 servoId 缺失或为 0 时回填冻结默认硬件号（禁止导入时冲掉真机校准）。
  list = list.map((b) => {
    if (b?.controlId === idF && b.channel === CHANNEL_VALUE) {
      const sid = Number(b.servoId)
      if (Number.isFinite(sid) && sid > 0) {
        return normalizeBinding(b)
      }
      return normalizeBinding({
        ...makeDofBinding(idF, servoFId),
        bindingId: b.bindingId || `bind_brow_tip_dof_${idF}_${servoFId}`,
      })
    }
    if (b?.controlId === idD && b.channel === CHANNEL_VALUE) {
      const sid = Number(b.servoId)
      if (Number.isFinite(sid) && sid > 0) {
        return normalizeBinding(b)
      }
      return normalizeBinding({
        ...makeDofBinding(idD, servoDId),
        bindingId: b.bindingId || `bind_brow_tip_dof_${idD}_${servoDId}`,
      })
    }
    return b
  })

  list = list.filter((b) => b?.controlId !== idTipA && b?.controlId !== idTipB)

  return list
}

function migrateRightBrowFDBindings(bindings) {
  return migrateSideBrowFDBindings(bindings, "r", BROW_R_F_SERVO_ID, BROW_R_D_SERVO_ID)
}

function migrateLeftBrowFDBindings(bindings) {
  return migrateSideBrowFDBindings(bindings, "l", BROW_L_F_SERVO_ID, BROW_L_D_SERVO_ID)
}

/**
 * 绑定迁移：旧 tip / tip+lateral → tip_a / tip_b，再升到 F/D。
 * @param {object[]} bindings
 */
export function patchBrowTipIndependentDofBindings(bindings) {
  let list = Array.isArray(bindings) ? [...bindings] : []

  for (const legacyId of LEGACY_TIP_IDS) {
    const side = legacyId.startsWith("brow_l") ? "l" : "r"
    const idA = `brow_${side}_tip_a`
    const idB = `brow_${side}_tip_b`

    const legacy = list.filter((b) => b?.controlId === legacyId && b.enabled !== false)
    if (legacy.length) {
      const valueBinds = legacy.filter((b) => b.channel === CHANNEL_VALUE || !b.channel)
      const lateralBinds = legacy.filter((b) => b.channel === CHANNEL_LATERAL)
      const xBinds = legacy.filter((b) => b.channel === "x")
      const yBinds = legacy.filter((b) => b.channel === "y")
      const remapped = []

      const aSource = valueBinds[0] || yBinds[0] || xBinds[0]
      if (aSource) {
        remapped.push(
          normalizeBinding({
            ...aSource,
            controlId: idA,
            channel: CHANNEL_VALUE,
          })
        )
      }
      const bSource = lateralBinds[0] || valueBinds[1] || xBinds[0] || yBinds[1]
      if (bSource && bSource !== aSource) {
        remapped.push(
          normalizeBinding({
            ...bSource,
            controlId: idB,
            channel: CHANNEL_VALUE,
          })
        )
      }

      list = list.filter((b) => b?.controlId !== legacyId)
      list.push(...remapped)
    }
  }

  /* 语义 tip 上不应残留舵机绑定 */
  list = list.filter((b) => {
    if (b?.controlId === "brow_l_tip" || b?.controlId === "brow_r_tip") return false
    return true
  })

  /* tip_a/tip_b / F/D 上的 lateral 通道改为 value */
  list = list.map((b) => {
    const id = b?.controlId
    if (
      !id?.endsWith("_tip_a") &&
      !id?.endsWith("_tip_b") &&
      id !== "brow_r_F" &&
      id !== "brow_r_D" &&
      id !== "brow_l_F" &&
      id !== "brow_l_D"
    ) {
      return b
    }
    if (b.channel === CHANNEL_VALUE) return b
    return normalizeBinding({ ...b, channel: CHANNEL_VALUE })
  })

  /*
   * 升 F/D 前：若 tip_a 上误挂两路，先把第二路迁到 tip_b。
   */
  for (const side of ["l", "r"]) {
    const idA = `brow_${side}_tip_a`
    const idB = `brow_${side}_tip_b`
    const aBinds = list.filter(
      (b) => b?.controlId === idA && b.channel === CHANNEL_VALUE && b.enabled !== false
    )
    const hasB = list.some(
      (b) => b?.controlId === idB && b.channel === CHANNEL_VALUE && b.enabled !== false
    )
    if (aBinds.length >= 2 && !hasB) {
      const moveIds = new Set(aBinds.slice(1).map((b) => b.bindingId))
      list = list.map((b) => {
        if (!moveIds.has(b?.bindingId)) return b
        return normalizeBinding({ ...b, controlId: idB, channel: CHANNEL_VALUE })
      })
    }
  }

  list = migrateRightBrowFDBindings(list)
  list = migrateLeftBrowFDBindings(list)

  return list
}

/** @deprecated 使用 {@link patchBrowTipIndependentDofBindings} */
export function patchBrowTipDualBindings(bindings) {
  return patchBrowTipIndependentDofBindings(bindings)
}

/**
 * controls + bindings 一体迁移。
 * @param {{ controls?: object[], bindings?: object[] }} profileSlice
 */
export function migrateBrowTipIndependentDof(profileSlice = {}) {
  const controls = ensureBrowTipIndependentDofControls(profileSlice.controls)
  const bindings = patchBrowTipIndependentDofBindings(profileSlice.bindings)
  return { controls, bindings }
}

export function profileNeedsBrowTipDualBindingPatch(profile) {
  if (!profile || profile.browTipDualBindingVersion === BROW_TIP_DUAL_BINDING_VERSION) {
    return false
  }
  return true
}
