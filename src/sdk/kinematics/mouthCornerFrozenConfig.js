/**
 * 嘴角五杆「冻结」配置 — 全站唯一语义源（Lab / 绑定 / Tracking / 表情编排共用）。
 * 调整方向、flip、默认中位、Lab 硬件舵机时：只改 {@link MOUTH_CORNER_LAB_SIDES}，并 bump FROZEN_VERSION。
 */
import { getMouthCornerLabSide } from "./mouthCornerFiveBarLabConfig.js"

/** @type {string} 变更 defaultCalibration / 绑定语义时递增 */
export const MOUTH_CORNER_FROZEN_VERSION = "2026-07-23.v6"

/**
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId
 */
export function getMouthCornerFrozenPadFlip(sideId = "right") {
  const d = getMouthCornerLabSide(sideId).defaultCalibration
  return {
    flipPadX: Boolean(d.flipPadX),
    flipPadY: Boolean(d.flipPadY),
    padRotateCcwDeg: Number(d.padRotateCcwDeg) || 0,
  }
}

/**
 * Runtime / IK 默认参数（不含 FiveBar 几何常量）。
 * @param {import("./mouthCornerFiveBarLabConfig.js").MouthCornerLabSideId | string} sideId
 */
export function getMouthCornerFrozenRuntimeDefaults(sideId = "right") {
  const side = getMouthCornerLabSide(sideId)
  const d = side.defaultCalibration
  return {
    ...getMouthCornerFrozenPadFlip(sideId),
    Kx: d.Kx,
    Ky: d.Ky,
    xSign: d.xSign,
    ySign: d.ySign,
    qSignA: d.qSignA,
    qSignB: d.qSignB,
    qGainA: d.qGainA,
    qGainB: d.qGainB,
    servoSwap: Boolean(d.servoSwap),
    neutralPwmA: d.neutralPwmA ?? null,
    neutralPwmB: d.neutralPwmB ?? null,
    labHwServoA: side.labHwServoA,
    labHwServoB: side.labHwServoB,
  }
}

/** Rig UI pad 语义：50/50 为控件中位，与 mouth.sideL / mouth.sideR 一致 */
export const MOUTH_CORNER_PAD_CENTER = { x: 50, y: 50 }

/** Lab / 调试常用 pad 预设（与 Rig 坐标系相同：x/y 均为 0~100） */
export function getMouthCornerPadPresets(sideId = "right") {
  const outwardX = sideId === "left" ? 40 : 60
  const inwardX = sideId === "left" ? 60 : 40
  return [
    { id: "center", label: "Center 50/50", x: 50, y: 50 },
    { id: "outward", label: `Outward ${outwardX}/50`, x: outwardX, y: 50 },
    { id: "inward", label: `Inward ${inwardX}/50`, x: inwardX, y: 50 },
    { id: "py", label: "+Y 50/40", x: 50, y: 40 },
    { id: "my", label: "-Y 50/60", x: 50, y: 60 },
    { id: "ru", label: "Up-Out 60/40", x: sideId === "left" ? 40 : 60, y: 40 },
    { id: "rd", label: "Down-Out 60/60", x: sideId === "left" ? 40 : 60, y: 60 },
  ]
}
