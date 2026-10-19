/** Video Device Dry-run：生成 binding / safety 诊断，禁止真实总线写入。 */

export const VIDEO_DEVICE_DRY_RUN_BLOCKED_REASON = "video-preview-only-dry-run"

export const TRACKING_VIDEO_DEVICE_DRY_RUN_STORAGE_KEY =
  "facedev.tracking.videoDeviceDryRunEnabled"

export const VIDEO_DEVICE_DRIVE_MODES = /** @type {const} */ ({
  OFF: "off",
  DRY_RUN: "dry_run",
  REAL: "real",
  REAL_SMOKE_TEST: "real_smoke_test",
})
