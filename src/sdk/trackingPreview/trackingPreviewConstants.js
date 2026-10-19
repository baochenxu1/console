/** @typedef {'camera' | 'video' | 'upload' | 'motion-track'} TrackingPreviewTabId */
/** @typedef {'preview-only' | 'dry-run' | 'device-drive'} TrackingPreviewDriveMode */

export const TRACKING_PREVIEW_TABS = /** @type {const} */ ({
  CAMERA: "camera",
  VIDEO: "video",
  UPLOAD: "upload",
  MOTION_TRACK: "motion-track",
})

export const TRACKING_PREVIEW_TAB_LABELS = {
  [TRACKING_PREVIEW_TABS.CAMERA]: "Camera Preview",
  [TRACKING_PREVIEW_TABS.VIDEO]: "Video Preview",
  [TRACKING_PREVIEW_TABS.UPLOAD]: "Uploaded Video",
  [TRACKING_PREVIEW_TABS.MOTION_TRACK]: "Motion Track",
}

/** Phase 3.0 — Header Source 分段（Idle / Camera / Video / Motion Track / Upload） */
export const TRACKING_SOURCE_SEGMENT_IDS = /** @type {const} */ ({
  IDLE: "idle",
  CAMERA: "camera",
  VIDEO: "video",
  MOTION_TRACK: "motion-track",
  UPLOAD: "upload",
})

export const TRACKING_SOURCE_SEGMENT_LABELS = {
  [TRACKING_SOURCE_SEGMENT_IDS.IDLE]: "Idle",
  [TRACKING_SOURCE_SEGMENT_IDS.CAMERA]: "Camera",
  [TRACKING_SOURCE_SEGMENT_IDS.VIDEO]: "Video",
  [TRACKING_SOURCE_SEGMENT_IDS.MOTION_TRACK]: "Motion Track",
  [TRACKING_SOURCE_SEGMENT_IDS.UPLOAD]: "Upload",
}

/** 输入源 idle 态说明（Camera 预览区等） */
export const TRACKING_SOURCE_IDLE_GUIDE = [
  {
    id: TRACKING_SOURCE_SEGMENT_IDS.IDLE,
    label: "Idle",
    desc: "关闭采集，后端待机，不占用摄像头或视频文件",
  },
  {
    id: TRACKING_SOURCE_SEGMENT_IDS.CAMERA,
    label: "Camera",
    desc: "选择摄像头设备后初始化，实时采集（可 Device Drive）",
  },
  {
    id: TRACKING_SOURCE_SEGMENT_IDS.VIDEO,
    label: "Video",
    desc: "默认测试视频，Preview Only，启用 Video Source Tuning",
  },
  {
    id: TRACKING_SOURCE_SEGMENT_IDS.MOTION_TRACK,
    label: "Motion Track",
    desc: "动作轨道编辑，不连接 tracking 输入源",
  },
  {
    id: TRACKING_SOURCE_SEGMENT_IDS.UPLOAD,
    label: "Upload",
    desc: "上传本地视频，Preview Only，启用 Video Source Tuning",
  },
]

export const DRIVE_MODES = /** @type {const} */ ({
  PREVIEW_ONLY: "preview-only",
  DRY_RUN: "dry-run",
  DEVICE_DRIVE: "device-drive",
})

export const DRIVE_MODE_LABELS = {
  [DRIVE_MODES.PREVIEW_ONLY]: "Preview Only",
  [DRIVE_MODES.DRY_RUN]: "Dry Run",
  [DRIVE_MODES.DEVICE_DRIVE]: "Device Drive",
}

/** @typedef {'bus-servo'} TrackingPreviewOutputMode */

export const OUTPUT_MODES = /** @type {const} */ ({
  BUS_SERVO: "bus-servo",
})

export const OUTPUT_MODE_LABELS = {
  [OUTPUT_MODES.BUS_SERVO]: "Bus Servo",
}

/** 将历史 localStorage `"pwm"` 迁移为总线模式。 */
export function normalizeTrackingOutputMode(raw) {
  return OUTPUT_MODES.BUS_SERVO
}

export const TRACKING_OUTPUT_MODE_STORAGE_KEY = "facedev.tracking.outputMode"
export const TRACKING_BUS_TX_MODE_STORAGE_KEY = "facedev.tracking.busServoTxMode"
export const TRACKING_DIAGNOSTIC_MODE_STORAGE_KEY = "facedev.tracking.diagnosticMode"
export const TRACKING_VIDEO_SOURCE_TUNING_STORAGE_KEY = "facedev.tracking.videoSourceTuningEnabled"
export { TRACKING_VIDEO_DEVICE_DRY_RUN_STORAGE_KEY } from "./videoDeviceDryRunConstants.js"
export {
  TRACKING_VIDEO_REAL_SEND_SMOKE_TEST_STORAGE_KEY,
  TRACKING_VIDEO_SMOKE_TEST_PROFILE_STORAGE_KEY,
} from "./videoRealSendSmokeTest.js"

/** @typedef {'off' | 'compact' | 'full'} DiagnosticMode */

export const DIAGNOSTIC_MODES = /** @type {const} */ ({
  OFF: "off",
  COMPACT: "compact",
  FULL: "full",
})

/** @typedef {'full' | 'ai-review'} DiagnosticExportMode */

export const DIAGNOSTIC_EXPORT_MODES = /** @type {const} */ ({
  FULL: "full",
  AI_REVIEW: "ai-review",
})

export const TRACKING_DIAGNOSTIC_EXPORT_MODE_STORAGE_KEY =
  "facedev.tracking.diagnosticExportMode"

export const DIAGNOSTIC_MODE_LABELS = {
  [DIAGNOSTIC_MODES.OFF]: "off（最流畅，无录制）",
  [DIAGNOSTIC_MODES.COMPACT]: "compact（默认，轻量指标）",
  [DIAGNOSTIC_MODES.FULL]: "full（完整排查，可能影响实时）",
}

export const DEFAULT_WS_CAMERA = "ws://127.0.0.1:8766/tracking"

/** Phase 4.1-D：独立 MJPEG 预览通道（与 WebSocket tracking 端口分离） */
export const DEFAULT_PREVIEW_PORT = 8767
export const CAMERA_PREVIEW_PATH = "/preview.mjpg"
export const DEFAULT_CAMERA_PREVIEW_HTTP = `http://127.0.0.1:${DEFAULT_PREVIEW_PORT}${CAMERA_PREVIEW_PATH}`

/**
 * 由 WebSocket hostname + 固定 preview 端口推导 MJPEG URL。
 * @param {string} [wsUrl]
 * @param {number} [previewPort]
 */
export function buildCameraPreviewMjpegUrl(
  wsUrl = DEFAULT_WS_CAMERA,
  previewPort = DEFAULT_PREVIEW_PORT
) {
  try {
    const u = new URL(wsUrl)
    const host = u.hostname || "127.0.0.1"
    return `http://${host}:${previewPort}${CAMERA_PREVIEW_PATH}`
  } catch {
    return DEFAULT_CAMERA_PREVIEW_HTTP
  }
}

export const DEVICE_DRIVE_QUALITY_MIN = 0.5

/**
 * Device Drive 实机下发默认策略：统一实时节拍。
 * 平滑靠 mapping / actuator slew safety 实现，不靠"不发送"（cooldown / 分频）制造。
 */
/** @typedef {'single-write' | 'hybrid' | 'sync-write'} BusServoTxMode */
/** @typedef {'sync-inst' | 'reg-action'} BusServoSyncMode */

export const DEVICE_DRIVE_DEFAULTS = {
  maxSendFps: 45,
  /** SC sync-inst 0x83 + ST single-write；sync-write 全协议仅测试用 */
  busServoTxMode: /** @type {BusServoTxMode} */ ("hybrid"),
  /** SC 同步写子模式：Device Drive 默认 sync-inst 0x83 broadcast 0xFE */
  scsclSyncMode: /** @type {BusServoSyncMode} */ ("sync-inst"),
  /** @deprecated 使用 scsclSyncMode */
  busServoSyncMode: /** @type {BusServoSyncMode} */ ("sync-inst"),
  /** ST 舵机发送模式（现阶段固定 single-write） */
  smsStsTxMode: /** @type {'single-write'} */ ("single-write"),
  /** 诊断采集：off / compact / full */
  diagnosticMode: /** @type {DiagnosticMode} */ (DIAGNOSTIC_MODES.COMPACT),
  /** SC 同步写 / ACTION 广播 ID：Lab 验证 0xFE 可用，0xFF 无效 */
  scsclBroadcastId: /** @type {0xff | 0xfe} */ (0xfe),

  // 不再使用 lip/jaw 独立发送 FPS，避免嘴唇 / 下巴 / 嘴角不同步
  jawMaxSendFps: null,
  lipMaxSendFps: null,

  // tracking 实时输出不使用 same-command cooldown
  sameCommandCooldownMs: 0,
  lipSameCommandCooldownMs: 0,
  jawSameCommandCooldownMs: 0,

  // delta 只用于极小抖动过滤，不用于降低主响应
  minPwmDeltaUs: 1,
  jawMinPwmDeltaUs: 1,
  lipMinPwmDeltaUs: 1,

  lipRigDeadband: 0,
  servoTimeMs: 15,
  dropStaleFrame: true,
}

export const TRACKING_DEVICE_DRIVE_STOP_DEFAULTS = {
  stopReturnNeutralEnabled: true,
  /** PWM 回中 MOVE 时长 */
  stopReturnNeutralTimeMs: 1000,
  /** Bus 舵机 profile.time 下限（回中动作更慢、更顺） */
  stopReturnNeutralBusMoveTimeMs: 900,
  /** 回中命令重复发送次数（串口保持连接时确保到位） */
  stopReturnNeutralRepeatCount: 2,
  /** 重复发送间隔 */
  stopReturnNeutralRepeatIntervalMs: 500,
  /** 末次回中后等待（让舵机完成动作再 Stop camera） */
  stopNeutralHoldMs: 650,
  /** Bus 回中优先 hybrid sync，整脸同时回中 */
  stopReturnNeutralBusTxMode: "hybrid",
  /** "face-neutral" | "stop-servo" | "both" */
  stopReturnNeutralMode: "face-neutral",
}

/** Arm Device Drive 时从中位平滑过渡到当前 tracking 姿态 */
export const TRACKING_DEVICE_DRIVE_ARM_DEFAULTS = {
  armWarmupEnabled: true,
  armWarmupSteps: 6,
  armWarmupStepIntervalMs: 120,
  armWarmupBusMoveTimeMs: 220,
  armWarmupPwmTimeMs: 450,
  armWarmupFromLogical: 500,
  armWarmupBusTxMode: "hybrid",
}

export const DEVICE_DRIVE_ARM_CONFIRM_MESSAGE =
  "Device Drive — 实机下发\n\n" +
  "将向已绑定的全部舵机通道下发命令（含左右嘴角 FiveBar）。\n" +
  "请确认串口已连接、机构安全，并已 Start Camera Tracking。\n\n" +
  "无人脸、quality 过低或串口未连接时不会发送。\n\n" +
  "确定 Arm Device Drive？"

export const MOTION_TRACK_VERSION = "facedev.motionTrack.v1"
