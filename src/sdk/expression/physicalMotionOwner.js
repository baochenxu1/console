/**
 * Physical motion ownership — exclusive flags for Face/Neck hardware output.
 * Not a hardware FIFO. Pages register while they actually own physical motion.
 */

export const PHYSICAL_MOTION_OWNERS = Object.freeze({
  TRACKING_DEVICE_DRIVE: "TRACKING_DEVICE_DRIVE",
  TIMELINE_PLAYBACK: "TIMELINE_PLAYBACK",
  BINDING_HARDWARE_TEST: "BINDING_HARDWARE_TEST",
  NECK_CALIBRATION: "NECK_CALIBRATION",
  PRESET_PLAYBACK: "PRESET_PLAYBACK",
})

const holders = new Set()

export function resetPhysicalMotionOwnersForTests() {
  holders.clear()
}

export function acquirePhysicalMotionOwner(ownerId) {
  const id = String(ownerId || "")
  if (!id) return false
  holders.add(id)
  return true
}

export function releasePhysicalMotionOwner(ownerId) {
  holders.delete(String(ownerId || ""))
}

export function listPhysicalMotionOwners() {
  return Array.from(holders)
}

export function isPhysicalMotionOwnerActive(ownerId) {
  return holders.has(String(ownerId || ""))
}

export function describePresetPlaybackBlockReason(activeOwners = listPhysicalMotionOwners()) {
  const set = new Set(activeOwners.map(String))
  if (set.has(PHYSICAL_MOTION_OWNERS.TRACKING_DEVICE_DRIVE)) {
    return "追踪预览正在驱动设备，请先停止追踪后再播放预设。"
  }
  if (set.has(PHYSICAL_MOTION_OWNERS.TIMELINE_PLAYBACK)) {
    return "表情时间轴正在播放，请先停止后再播放预设。"
  }
  if (set.has(PHYSICAL_MOTION_OWNERS.BINDING_HARDWARE_TEST)) {
    return "绑定硬件测试正在占用输出，请先结束后再播放预设。"
  }
  if (set.has(PHYSICAL_MOTION_OWNERS.NECK_CALIBRATION)) {
    return "标定正在占用输出，请先结束后再播放预设。"
  }
  if (set.has(PHYSICAL_MOTION_OWNERS.PRESET_PLAYBACK)) {
    return "预设正在播放，请等待完成或停止并回中。"
  }
  return ""
}
