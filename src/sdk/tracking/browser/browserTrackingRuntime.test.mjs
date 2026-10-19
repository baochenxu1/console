/**
 * Browser MediaPipe Runtime Phase 1 — 自动测试 A–M（纯函数与契约）
 */
import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createLatestFrameGate,
  createMonotonicTimestampGuard,
} from "./latestFrameGate.js"
import {
  normalizeBlendshapeCategories,
  normalizeFaceLandmarks,
  normalizeFacialTransformationMatrix,
  normalizeBrowserFaceLandmarkerResult,
} from "./browserTrackingNormalizer.js"
import { mapBlendshapesToEliteRig, DEBUG_BLEND_KEYS } from "./browserBlendshapeToRig.js"
import {
  TRACKING_BACKEND_BROWSER,
  TRACKING_BACKEND_PYTHON,
  normalizeTrackingBackend,
} from "./browserTrackingConfig.js"
import { TRACKING_FRAME_TYPE } from "../trackingTypes.js"
import { normalizeRigFrameMessage } from "../trackingMapper.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "../../../..")

test("A — Normalizer landmarks 保留 478 index 顺序", () => {
  const raw = Array.from({ length: 478 }, (_, i) => ({ x: i / 478, y: 0.5, z: 0 }))
  const out = normalizeFaceLandmarks(raw)
  assert.equal(out.length, 478)
  assert.equal(out[0].i, 0)
  assert.equal(out[477].i, 477)
  assert.ok(Math.abs(out[100].x - 100 / 478) < 1e-9)
})

test("B — Blendshapes categoryName → score 映射", () => {
  const cats = [
    { categoryName: "jawOpen", score: 0.42 },
    { categoryName: "eyeBlinkLeft", score: 0.8 },
    { categoryName: "mouthSmileRight", score: 0.1 },
  ]
  const out = normalizeBlendshapeCategories(cats)
  for (const k of DEBUG_BLEND_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, k))
  }
  assert.equal(out.jawOpen, 0.42)
  assert.equal(out.eyeBlinkLeft, 0.8)
  assert.equal(out.mouthSmileRight, 0.1)
  assert.equal(out.browInnerUp, 0)
})

test("C — Transformation matrix column-major 保持", () => {
  const colMajor = Array.from({ length: 16 }, (_, i) => i + 1)
  const out = normalizeFacialTransformationMatrix({ data: colMajor })
  assert.equal(out.layout, "column-major")
  assert.equal(out.rows, 4)
  assert.equal(out.cols, 4)
  assert.deepEqual(out.values, colMajor)
})

test("D — no face 不 crash，正式 lost tracking 语义", () => {
  const frame = normalizeBrowserFaceLandmarkerResult(
    { faceLandmarks: [], faceBlendshapes: [], facialTransformationMatrixes: [] },
    { captureTimestamp: 10, frameSeq: 1 }
  )
  assert.equal(frame.type, TRACKING_FRAME_TYPE)
  assert.equal(frame.faceDetected, false)
  assert.equal(frame.quality, 0)
  assert.equal(frame.source, "mediapipe-web")
})

test("E — latest frame wins（无 FIFO）", () => {
  const gate = createLatestFrameGate()
  assert.equal(gate.offer({ id: 1 }), "accepted")
  gate.beginInference()
  assert.equal(gate.offer({ id: 2 }), "pending")
  assert.equal(gate.offer({ id: 3 }), "pending")
  assert.equal(gate.offer({ id: 4 }), "pending")
  const next = gate.endInference()
  assert.equal(next.id, 4)
  const stats = gate.getStats()
  assert.equal(stats.droppedFrames, 2)
  assert.ok(stats.capturedFrames >= 4)
})

test("F — monotonic timestamp", () => {
  const g = createMonotonicTimestampGuard(0)
  assert.equal(g.next(10), 10)
  assert.equal(g.next(10), 11)
  assert.equal(g.next(5), 12)
  assert.equal(g.next(100), 100)
})

test("G — provider lifecycle exclusivity helpers", () => {
  assert.equal(normalizeTrackingBackend("browser"), TRACKING_BACKEND_BROWSER)
  assert.equal(normalizeTrackingBackend("python"), TRACKING_BACKEND_PYTHON)
  assert.equal(normalizeTrackingBackend("mediapipe-web"), TRACKING_BACKEND_BROWSER)
})

test("H — backend exclusivity config", () => {
  // 任意时刻只能有一个 backend 值；切换由 controller 负责 stop 旧 provider
  assert.notEqual(TRACKING_BACKEND_BROWSER, TRACKING_BACKEND_PYTHON)
})

test("I — build asset paths configured", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  assert.ok(pkg.scripts["build:faceconsole-web"])
  assert.ok(pkg.scripts["prepare:mediapipe-assets"])
  assert.ok(pkg.dependencies["@mediapipe/tasks-vision"])
  assert.ok(existsSync(join(root, "scripts/prepare-browser-mediapipe-assets.mjs")))
  assert.ok(existsSync(join(root, "scripts/check-faceconsole-web-assets.mjs")))
  assert.ok(existsSync(join(root, "vite.faceconsole-web.config.js")))
})

test("J — browser backend 无 localhost 硬依赖（源码扫描）", () => {
  const files = [
    "browserFaceLandmarkerProvider.js",
    "browserFaceLandmarkerWorker.js",
    "browserTrackingNormalizer.js",
    "browserTrackingConfig.js",
  ]
  for (const name of files) {
    const src = readFileSync(join(__dirname, name), "utf8")
    assert.equal(src.includes("8766"), false, `${name} must not hardcode 8766`)
    assert.equal(src.includes("8767"), false, `${name} must not hardcode 8767`)
    assert.equal(src.includes("preview.mjpg"), false)
  }
})

test("K — downstream contract：Browser result → normalizeRigFrameMessage", () => {
  const landmarks = Array.from({ length: 478 }, (_, i) => ({ x: 0.1, y: 0.2, z: 0 }))
  const frame = normalizeBrowserFaceLandmarkerResult(
    {
      faceLandmarks: [landmarks],
      faceBlendshapes: [
        {
          categories: [
            { categoryName: "jawOpen", score: 0.5 },
            { categoryName: "eyeBlinkLeft", score: 0.2 },
            { categoryName: "eyeBlinkRight", score: 0.2 },
            { categoryName: "browInnerUp", score: 0.3 },
          ],
        },
      ],
      facialTransformationMatrixes: [{ data: Array.from({ length: 16 }, (_, i) => i) }],
    },
    { captureTimestamp: 50, inferenceStart: 50, inferenceEnd: 58, frameSeq: 3 }
  )
  assert.equal(frame.faceDetected, true)
  assert.ok(frame.rig)
  assert.equal(frame.debug.landmarkCount, 478)
  const normalized = normalizeRigFrameMessage(frame)
  assert.ok(normalized)
  assert.equal(normalized.type, TRACKING_FRAME_TYPE)
  assert.ok(normalized.rig.jaw)
})

test("L — Device Drive contract：无 Browser-specific servo send", () => {
  const provider = readFileSync(join(__dirname, "browserFaceLandmarkerProvider.js"), "utf8")
  assert.equal(provider.includes("sendBusServo"), false)
  assert.equal(provider.includes("dispatchBindingWorkbench"), false)
  assert.equal(provider.includes("rjHostMotionAdapter"), false)
  assert.ok(provider.includes("onFrame"))
})

test("M — SC/ST/RJ regression：Browser 层协议无关", () => {
  const files = [
    "browserFaceLandmarkerProvider.js",
    "browserTrackingNormalizer.js",
    "browserBlendshapeToRig.js",
  ]
  for (const name of files) {
    const src = readFileSync(join(__dirname, name), "utf8")
    assert.equal(src.includes("Scscl"), false)
    assert.equal(src.includes("syncWrite"), false)
    assert.equal(src.includes("rjSbus"), false)
  }
  const mapped = mapBlendshapesToEliteRig({ jawOpen: 0.4 })
  assert.ok(typeof mapped.rig.jaw.val === "number")
})

test("N — Worker 1.x module bootstrap（避免 importScripts）", () => {
  const worker = readFileSync(join(__dirname, "browserFaceLandmarkerWorker.js"), "utf8")
  assert.match(worker, /from\s+["']@mediapipe\/tasks-vision["']/)
  assert.match(worker, /forVisionTasks\([^)]*,\s*true\s*\)/)
  assert.match(worker, /modelAssetBuffer/)
  assert.equal(/importScripts\s*\(/.test(worker), false)
  assert.match(worker, /WORKER_INIT_ERROR|MODEL_LOAD_ERROR|WASM_LOAD_ERROR/)

  const pkg = JSON.parse(
    readFileSync(join(root, "node_modules/@mediapipe/tasks-vision/package.json"), "utf8")
  )
  assert.equal(pkg.version, "1.0.1")

  const moduleWasm = join(
    root,
    "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_module_internal.wasm"
  )
  assert.equal(existsSync(moduleWasm), true)
})

test("O — Stop 后再次 Start 不应卡 LOADING_MODEL（workerReady 契约）", () => {
  const provider = readFileSync(join(__dirname, "browserFaceLandmarkerProvider.js"), "utf8")
  assert.match(provider, /let workerReady = false/)
  assert.match(provider, /workerReady = true/)
  assert.match(provider, /else if \(workerReady\)/)
  assert.match(provider, /setLifecycle\(LIFECYCLE\.RUNNING\)/)

  const panel = readFileSync(
    join(root, "src/sdk/react/trackingPreview/CameraPreviewPanel.jsx"),
    "utf8"
  )
  assert.match(panel, /!trackingEnabled &&/)
  assert.match(panel, /LOADING_RUNTIME.*LOADING_MODEL/s)
})
