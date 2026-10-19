/**
 * 内置总线舵机 profile 回退源（仅本地文档与旧键皆空时使用）。
 * 正式数据在 facedev.servoConfigDocument.v1；旧 facedev.servoProfiles.v2 会在首次 load 时迁移折叠。
 */
export const BUS_SERVO_PROFILE_ACTIVE = {
  version: "facedev.servoConfigDocument.v1",
  projectType: "robot-face-servo-config",
  documentName: "内置种子舵机配置",
  createdAt: "2026-06-08T14:45:24.000Z",
  note: "Fallback when local document is empty",
  profiles: [],
}
