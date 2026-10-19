import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { createTrackingSemanticRuntime } from "../src/sdk/tracking/core/trackingSemanticCore.js"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixturePath = join(root, "src/sdk/tracking/core/fixtures/python-baseline-phase1b.json")
const reportPath = join(root, "docs/investigation/facedev-browser-python-semantic-parity-phase1b.json")

export const PARITY_TEST_CONFIG = {
  lipGeometry: { neutralFrames: 1, neutralWarmupFrames: 0, scenarioTransitionFrames: 1 },
  jawGeometry: { neutralFrames: 1, neutralWarmupFrames: 0 },
  noseAnchor: { neutralFrames: 1, neutralWarmupFrames: 0 },
  mouthCorner: { neutralSampleCount: 1, neutralWarmupFrames: 0 },
  browGate: { browConfirmFrames: 1, neutralFallbackMs: 0 },
  gaze: { irisWarmupFrames: 1, irisWarmupMinSamples: 1, irisWarmupMaxWaitFrames: 1 },
  mouthScenario: { frontalConfirmFrames: 1, closedTurnConfirmFrames: 1, neutralConfirmFrames: 1 },
}

export const RIG_CHANNELS = [
  "browL.tip", "browL.mid", "browL.tail", "browR.tip", "browR.mid", "browR.tail",
  "eyeL.up", "eyeL.lo", "eyeR.up", "eyeR.lo", "sharedRadar.x", "sharedRadar.y",
  "mouth.UL", "mouth.UR", "mouth.LL", "mouth.LR",
  "mouth.sideL.x", "mouth.sideL.y", "mouth.sideR.x", "mouth.sideR.y", "jaw.val",
]

function get(obj, path) {
  return path.split(".").reduce((value, key) => value?.[key], obj)
}

function percentile(values, p) {
  const a = [...values].sort((x, y) => x - y)
  if (!a.length) return 0
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))]
}

export async function compareSemanticParity() {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
  const runtime = createTrackingSemanticRuntime({ config: PARITY_TEST_CONFIG })
  const actualFrames = fixture.observations.map((observation) => runtime.process(observation))
  const perChannel = {}
  for (const channel of RIG_CHANNELS) {
    const errors = fixture.frames.map((expected, i) => Math.abs(Number(get(expected.rig, channel) || 0) - Number(get(actualFrames[i].rig, channel) || 0)))
    perChannel[channel] = {
      maxAbsError: Math.max(...errors),
      meanAbsError: errors.reduce((a, b) => a + b, 0) / errors.length,
      p95AbsError: percentile(errors, 0.95),
    }
  }
  const gateFrames = fixture.frames.map((expected, i) => ({
    name: expected.name,
    python: expected.scenario,
    sharedJs: actualFrames[i].debug.mouthScenarioClassifier.finalScenario,
    match: expected.scenario === actualFrames[i].debug.mouthScenarioClassifier.finalScenario,
  }))
  const headPose = Object.fromEntries(["yawProxy", "pitchProxy", "rollDeg", "faceScale"].map((channel) => {
    const errors = fixture.frames.map((expected, i) => Math.abs(
      Number(expected.headPose?.[channel] || 0) - Number(actualFrames[i].debug.headPose?.[channel] || 0),
    ))
    return [channel, {
      maxAbsError: Math.max(...errors),
      meanAbsError: errors.reduce((a, b) => a + b, 0) / errors.length,
      p95AbsError: percentile(errors, 0.95),
    }]
  }))
  const qualityErrors = fixture.frames.map((expected, i) => Math.abs(Number(expected.quality || 0) - Number(actualFrames[i].quality || 0)))
  const groups = {
    Brow: RIG_CHANNELS.filter((c) => c.startsWith("brow")),
    EyesBlink: RIG_CHANNELS.filter((c) => c.startsWith("eye")),
    Gaze: RIG_CHANNELS.filter((c) => c.startsWith("sharedRadar")),
    Mouth: RIG_CHANNELS.filter((c) => c.startsWith("mouth.") && !c.includes("side")),
    MouthCorner: RIG_CHANNELS.filter((c) => c.includes("mouth.side")),
    Jaw: ["jaw.val"],
  }
  const summary = Object.fromEntries(Object.entries(groups).map(([name, channels]) => {
    const max = Math.max(...channels.map((c) => perChannel[c].maxAbsError))
    return [name, { maxAbsError: max, status: max <= 1 ? "MATCH" : max <= 8 ? "CLOSE" : "DIFFERENT" }]
  }))
  const headPoseMax = Math.max(...Object.values(headPose).map((x) => x.maxAbsError))
  summary.HeadPose = {
    maxAbsError: headPoseMax,
    status: headPoseMax <= 0.01 ? "MATCH" : "CLOSE",
    note: "Formal path remains landmark mouth-frame yaw/pitch/roll proxies; facialTransformationMatrix is observation-only and does not drive Elite Rig (no headPose field).",
  }
  summary.Quality = {
    maxAbsError: Math.max(...qualityErrors),
    status: Math.max(...qualityErrors) <= 0.01 ? "MATCH" : "CLOSE",
    note: "JS estimateObservationQuality mirrors blendshape-count heuristic when MediaPipe confidences absent; Python estimate_tracking_quality uses the same family of signals.",
  }
  summary.Blink = summary.EyesBlink
  const report = {
    schema: "facedev.semantic-parity-report.v1",
    baseline: "formal Python mediapipe_result_to_rig (scripts/export-python-tracking-baseline.py)",
    sampleCount: fixture.frames.length,
    tolerance: { MATCH: 1, CLOSE: 8 },
    perChannel,
    headPose,
    quality: {
      maxAbsError: Math.max(...qualityErrors),
      meanAbsError: qualityErrors.reduce((a, b) => a + b, 0) / qualityErrors.length,
      p95AbsError: percentile(qualityErrors, 0.95),
    },
    gateFrames,
    gateFrameMatchRate: gateFrames.filter((f) => f.match).length / gateFrames.length,
    summary,
    architecture: {
      formalPath: "Provider → Canonical MediaPipe Observation → Shared Tracking Semantic Core → tracking.rigFrame",
      browserProviderOwnsRigMath: false,
      pythonProviderShortTerm: "still emits full rigFrame over WebSocket; observation contract is next step",
      headPoseMath: "landmark-mouth-frame (not matrix)",
      semanticComputeLocation: "main-thread Shared Core after Worker inference",
    },
  }
  return report
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await compareSemanticParity()
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(report, null, 2))
}
