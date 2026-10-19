/**
 * Camera coordinate convention — Python / Browser 统一 MediaPipe 输入约定。
 *
 * Python 正式 Camera（tracking_input_frame.transform_camera_frame）：
 *   cv2.flip(frame, 1) 后再送 FaceLandmarker
 *   → 「非镜像 / subject-left = image-left」
 *
 * Browser：
 *   - Preview CSS `scaleX(-1)` 只影响显示，不改变 createImageBitmap 像素
 *   - 因此推理前必须显式水平翻转 ImageBitmap，与 Python 对齐
 *
 * Shared Semantic Core 不按 runtime 分叉左右语义。
 */

export const CAMERA_COORDINATE_CONVENTION_ID = "subject-left-is-image-left"

export const CAMERA_COORDINATE_CONVENTION = Object.freeze({
  id: CAMERA_COORDINATE_CONVENTION_ID,
  /** Python camera: transform_camera_frame(..., flip_horizontal=True) */
  pythonCameraFlipHorizontal: true,
  /** Browser inference bitmap must match Python */
  browserInferenceFlipHorizontal: true,
  /**
   * CSS preview mirror on <video> — display only.
   * Does NOT affect createImageBitmap / Worker pixels.
   */
  browserPreviewCssMirror: true,
  description:
    "Non-mirrored MediaPipe input (subject left = image left). Matches Python cv2.flip(frame, 1).",
})

/**
 * 创建送入 FaceLandmarker 的 ImageBitmap。
 * 默认水平翻转，对齐 Python Camera。
 *
 * @param {CanvasImageSource} source HTMLVideoElement / ImageBitmap / canvas
 * @param {{ flipHorizontal?: boolean }} [options]
 * @returns {Promise<ImageBitmap>}
 */
export async function createBrowserInferenceImageBitmap(source, options = {}) {
  const flipHorizontal =
    options.flipHorizontal !== undefined
      ? Boolean(options.flipHorizontal)
      : CAMERA_COORDINATE_CONVENTION.browserInferenceFlipHorizontal

  if (!flipHorizontal) {
    return createImageBitmap(source)
  }

  const w = Number(source.videoWidth || source.width || source.codedWidth) || 0
  const h = Number(source.videoHeight || source.height || source.codedHeight) || 0
  if (w < 2 || h < 2) {
    return createImageBitmap(source)
  }

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      return createImageBitmap(source)
    }
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(source, 0, 0, w, h)
    return createImageBitmap(canvas)
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      return createImageBitmap(source)
    }
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(source, 0, 0, w, h)
    return createImageBitmap(canvas)
  }

  return createImageBitmap(source)
}

/**
 * 纯函数：将归一化 landmark x 按约定镜像（用于测试 / 离线对齐，正式路径用像素翻转）。
 * @param {Array<{x?:number,y?:number,z?:number}>} landmarks
 */
export function mirrorNormalizedLandmarksX(landmarks) {
  if (!Array.isArray(landmarks)) return []
  return landmarks.map((p) => ({
    ...p,
    x: 1 - (Number(p?.x) || 0),
  }))
}
