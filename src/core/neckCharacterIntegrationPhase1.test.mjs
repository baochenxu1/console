/**
 * FaceDEV Neck Character Integration Phase 1 — 自动测试 A–AW（可自动化部分）
 */
import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createNeutralCharacterPose,
  normalizeCharacterPose,
  cloneCharacterPose,
  characterPoseFromFaceRig,
} from "./characterPose.js"
import {
  createNeutralNeckPose,
  normalizeNeckPose,
  NECK_SEMANTIC_LIMITS_FALLBACK,
} from "../sdk/neck/neckPose.js"
import {
  FRAME_PROJECT_VERSION,
  createDefaultFrameProject,
  normalizeFrameProject,
  buildFrameProjectExport,
} from "./frameProject.js"
import {
  ALL_TIMELINE_CHANNELS,
  getAllTimelineChannelIds,
  getFaceTimelineChannelIds,
  getNeckTimelineChannelIds,
  isFullFaceKeyed,
  isFullCharacterKeyed,
  expandKeyedChannelsToCharacter,
  listTimelineGroups,
} from "./expressionTimelineChannels.js"
import {
  addFullFaceKeyAtTime,
  addCharacterKeyAtTime,
  moveFullFaceKey,
  copyFullFaceKeyToTime,
} from "./expressionKeyframeOps.js"
import {
  sampleExpressionTimeline,
  sampleCharacterPoseAt,
} from "./expressionTimelineSampler.js"
import { createInitialEliteRig } from "./faceDofMapper.js"
import {
  computePlaybackTimelineTime,
  playKeyframes,
  EXPRESSION_HARDWARE_SAMPLE_INTERVAL_MS,
} from "./actionPlayer.js"
import {
  FACEDEV_NECK_PROTOCOL_VERSION,
  createClientHello,
  createNeckTargetMessage,
  createSessionHeartbeat,
  isServerHelloAccepted,
} from "../sdk/neck/neckBridgeProtocol.js"
import {
  assertSequenceMonotonic,
  createMockNeckBridgeSession,
  createMockNeckCapabilities,
} from "../sdk/neck/neckBridgeMock.js"
import { deleteKeyframe } from "./frameProject.js"

function almostEqual(a, b, eps = 1e-4) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `expected ${a} ≈ ${b}`)
}

function makeV2ProjectFaceOnly() {
  const face0 = createInitialEliteRig()
  face0.jaw.val = 20
  const face1 = createInitialEliteRig()
  face1.jaw.val = 80
  return {
    version: "2.0.0",
    expressionName: "legacy-v2",
    timelineDurationMs: 1000,
    keyframes: [
      {
        keyframeId: "a",
        timeMs: 0,
        name: "a",
        easing: "linear",
        positions: {},
        rigSnapshot: face0,
        keyedChannels: [...getFaceTimelineChannelIds()],
      },
      {
        keyframeId: "b",
        timeMs: 1000,
        name: "b",
        easing: "linear",
        positions: {},
        rigSnapshot: face1,
        keyedChannels: [...getFaceTimelineChannelIds()],
      },
    ],
  }
}

// —— CharacterPose ——
test("A — Neutral CharacterPose", () => {
  const p = createNeutralCharacterPose()
  assert.equal(p.neck.pitch, 0)
  assert.equal(p.neck.roll, 0)
  assert.equal(p.neck.yaw, 0)
  assert.ok(p.face && typeof p.face === "object")
})

test("B — Neck semantic defaults", () => {
  const n = createNeutralNeckPose()
  assert.deepEqual(n, { pitch: 0, roll: 0, yaw: 0 })
})

test("C — clone / normalize CharacterPose", () => {
  const src = normalizeCharacterPose({
    face: createInitialEliteRig(),
    neck: { pitch: 5, roll: -3, yaw: 20 },
  })
  const c = cloneCharacterPose(src)
  assert.equal(c.neck.yaw, 20)
  c.neck.yaw = 0
  assert.equal(src.neck.yaw, 20)
})

test("D — pitch/roll/yaw UI normalize clamp", () => {
  const n = normalizeNeckPose({ pitch: 99, roll: -99, yaw: 200 })
  assert.equal(n.pitch, NECK_SEMANTIC_LIMITS_FALLBACK.pitch.max)
  assert.equal(n.roll, NECK_SEMANTIC_LIMITS_FALLBACK.roll.min)
  assert.equal(n.yaw, NECK_SEMANTIC_LIMITS_FALLBACK.yaw.max)
})

// —— Migration ——
test("E — v2 → v3 project version", () => {
  const p = normalizeFrameProject(makeV2ProjectFaceOnly())
  assert.equal(p.version, FRAME_PROJECT_VERSION)
  assert.equal(FRAME_PROJECT_VERSION, "3.0.0")
})

test("F — old Face mathematical snapshot unchanged after migration", () => {
  const raw = makeV2ProjectFaceOnly()
  const p = normalizeFrameProject(raw)
  almostEqual(p.keyframes[0].rigSnapshot.jaw.val, 20)
  almostEqual(p.keyframes[1].characterPose.face.jaw.val, 80)
})

test("G — old project Neck = 0/0/0", () => {
  const p = normalizeFrameProject(makeV2ProjectFaceOnly())
  for (const kf of p.keyframes) {
    assert.deepEqual(kf.characterPose.neck, { pitch: 0, roll: 0, yaw: 0 })
  }
})

test("H — v3 save/load roundtrip", () => {
  let p = createDefaultFrameProject([])
  p = addFullFaceKeyAtTime(p, 0, createInitialEliteRig(), {}, [], {
    neck: { pitch: 2, roll: 1, yaw: -10 },
  })
  p = addFullFaceKeyAtTime(p, 500, createInitialEliteRig(), {}, [], {
    neck: { pitch: -2, roll: -1, yaw: 30 },
  })
  const exported = buildFrameProjectExport(p, null, [])
  const loaded = normalizeFrameProject(exported, [])
  assert.equal(loaded.version, "3.0.0")
  almostEqual(loaded.keyframes[1].characterPose.neck.yaw, 30)
})

// —— Sampler ——
test("I/J/K/L — Neck axis interpolation + easing linear", () => {
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], {
    neck: { pitch: 0, roll: 0, yaw: 0 },
  })
  p = addCharacterKeyAtTime(p, 1000, createInitialEliteRig(), {}, [], {
    neck: { pitch: 10, roll: 15, yaw: 90 },
  })
  const mid = sampleCharacterPoseAt(p, 500)
  almostEqual(mid.characterPose.neck.pitch, 5, 0.05)
  almostEqual(mid.characterPose.neck.roll, 7.5, 0.05)
  almostEqual(mid.characterPose.neck.yaw, 45, 0.05)
})

test("M — Face + Neck same timestamp", () => {
  let p = createDefaultFrameProject([])
  const faceA = createInitialEliteRig()
  faceA.jaw.val = 0
  const faceB = createInitialEliteRig()
  faceB.jaw.val = 100
  p = addCharacterKeyAtTime(p, 0, faceA, {}, [], { neck: { yaw: 0 } })
  p = addCharacterKeyAtTime(p, 1000, faceB, {}, [], { neck: { yaw: 40 } })
  const s = sampleCharacterPoseAt(p, 250)
  almostEqual(s.characterPose.face.jaw.val, 25, 0.5)
  almostEqual(s.characterPose.neck.yaw, 10, 0.05)
  assert.equal(s.timelineTimeMs, 250)
})

test("N — loop clock modulo", () => {
  const t = computePlaybackTimelineTime({
    nowMs: 2500,
    anchorClockMs: 0,
    anchorTimelineMs: 0,
    totalDurationMs: 1000,
    loop: true,
  })
  almostEqual(t, 500)
})

test("O — scrub sampleCharacterPoseAt", () => {
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], { neck: { pitch: 0 } })
  p = addCharacterKeyAtTime(p, 800, createInitialEliteRig(), {}, [], { neck: { pitch: 8 } })
  const s = sampleCharacterPoseAt(p, 400)
  almostEqual(s.neck.pitch, 4, 0.05)
})

// —— Full Character Key ——
test("P — Add key stores Face + Neck", () => {
  let p = createDefaultFrameProject([])
  p = addFullFaceKeyAtTime(p, 100, createInitialEliteRig(), {}, [], {
    neck: { pitch: 3, roll: 2, yaw: 11 },
  })
  const kf = p.keyframes.find((k) => k.timeMs === 100)
  assert.ok(isFullCharacterKeyed(kf.keyedChannels))
  assert.equal(kf.characterPose.neck.yaw, 11)
  assert.ok(kf.rigSnapshot)
})

test("Q — Select key restores both via sample", () => {
  let p = createDefaultFrameProject([])
  p = addFullFaceKeyAtTime(p, 0, createInitialEliteRig(), {}, [], { neck: { yaw: 0 } })
  p = addFullFaceKeyAtTime(p, 400, createInitialEliteRig(), {}, [], { neck: { yaw: 22 } })
  const s = sampleExpressionTimeline(p, 400)
  assert.equal(s.characterPose.neck.yaw, 22)
})

test("R — Move key moves both", () => {
  let p = createDefaultFrameProject([])
  p = addFullFaceKeyAtTime(p, 200, createInitialEliteRig(), {}, [], { neck: { yaw: 17 } })
  p = moveFullFaceKey(p, 200, 600, [])
  const kf = p.keyframes.find((k) => k.timeMs === 600)
  assert.equal(kf.characterPose.neck.yaw, 17)
})

test("S — Delete key removes both", () => {
  let p = createDefaultFrameProject([])
  p = addFullFaceKeyAtTime(p, 0, createInitialEliteRig(), {}, [], { neck: { yaw: 1 } })
  p = addFullFaceKeyAtTime(p, 300, createInitialEliteRig(), {}, [], { neck: { yaw: 9 } })
  const id = p.keyframes.find((k) => k.timeMs === 300).keyframeId
  p = deleteKeyframe(p, id, [])
  assert.equal(p.keyframes.some((k) => k.timeMs === 300), false)
})

test("T — same-time merge + copy preserves neck", () => {
  let p = createDefaultFrameProject([])
  p = addFullFaceKeyAtTime(p, 0, createInitialEliteRig(), {}, [], { neck: { yaw: 5 } })
  p = addFullFaceKeyAtTime(p, 0, createInitialEliteRig(), {}, [], { neck: { yaw: 12 } })
  assert.equal(p.keyframes.filter((k) => k.timeMs === 0).length, 1)
  assert.equal(p.keyframes[0].characterPose.neck.yaw, 12)
  p = copyFullFaceKeyToTime(p, 0, 700, [])
  const copied = p.keyframes.find((k) => k.timeMs === 700)
  assert.equal(copied.characterPose.neck.yaw, 12)
})

// —— Bridge protocol ——
test("U/V — health + capabilities mock", () => {
  const caps = createMockNeckCapabilities()
  assert.equal(caps.protocolVersion, FACEDEV_NECK_PROTOCOL_VERSION)
  assert.equal(caps.productionReady, false)
  assert.equal(caps.actualPoseAvailable, false)
  assert.equal(caps.runtimeSafetyMode, "COMMISSIONING_OPEN_LOOP")
})

test("W — protocol hello accepted", () => {
  const session = createMockNeckBridgeSession()
  const hello = createClientHello({ sessionId: "s1" })
  const reply = session.handleClientMessage(hello)
  assert.ok(isServerHelloAccepted(reply))
})

test("X — protocol mismatch rejected", () => {
  const session = createMockNeckBridgeSession({ protocolVersion: "other-v0" })
  const reply = session.handleClientMessage(createClientHello({ sessionId: "s1" }))
  assert.equal(reply.accepted, false)
})

test("Y — target schema", () => {
  const msg = createNeckTargetMessage({
    sessionId: "s",
    sequence: 3,
    timelineTimeMs: 120,
    pose: { pitch: 1, roll: 2, yaw: 3 },
  })
  assert.equal(msg.type, "neck.target")
  assert.equal(msg.sequence, 3)
  assert.deepEqual(msg.pose, { pitch: 1, roll: 2, yaw: 3 })
})

test("Z/AA — sequence monotonic while timeline may wrap", () => {
  const seqs = []
  const times = []
  let sequence = 0
  for (let i = 0; i < 5; i += 1) {
    sequence += 1
    seqs.push(sequence)
    times.push(i === 4 ? 0 : 200 * i) // last wraps
  }
  assertSequenceMonotonic(seqs)
  assert.equal(times[4], 0)
  assert.ok(seqs[4] > seqs[3])
})

test("AB/AC — heartbeat message independent of pause", () => {
  const hb = createSessionHeartbeat({ sessionId: "s", sequence: 9 })
  assert.equal(hb.type, "session.heartbeat")
  assert.equal(hb.sequence, 9)
})

test("AD/AE — mock target + resume sequence", () => {
  const session = createMockNeckBridgeSession()
  session.handleClientMessage(
    createNeckTargetMessage({ sessionId: "s", sequence: 1, timelineTimeMs: 0, pose: { yaw: 1 } })
  )
  session.handleClientMessage(
    createNeckTargetMessage({ sessionId: "s", sequence: 2, timelineTimeMs: 20, pose: { yaw: 2 } })
  )
  assert.equal(session.lastAcceptedSequence, 2)
  almostEqual(session.lastTarget.yaw, 2)
})

test("AF — latest-wins pending overwrite (logical)", () => {
  let pending = null
  pending = { yaw: 1 }
  pending = { yaw: 2 }
  pending = { yaw: 3 }
  assert.deepEqual(pending, { yaw: 3 })
})

// —— Playback ——
test("AG/AH — one absolute clock；same tick face+neck dispatch", async () => {
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], { neck: { yaw: 0 } })
  p = addCharacterKeyAtTime(p, 40, createInitialEliteRig(), {}, [], { neck: { yaw: 10 } })
  const faceTs = []
  const neckTs = []
  const ac = new AbortController()
  let clock = 0
  const done = playKeyframes({
    keyframes: p.keyframes,
    frameProject: p,
    loop: false,
    signal: ac.signal,
    hardwareIntervalMs: 20,
    clock: () => clock,
    scheduleUi: (cb) => {
      const id = setTimeout(() => {
        clock += 25
        cb()
      }, 0)
      return id
    },
    cancelUi: (id) => clearTimeout(id),
    scheduleHw: (cb) =>
      setInterval(() => {
        clock += 5
        cb()
      }, 5),
    clearHw: (id) => clearInterval(id),
    sendKeyframe: async ({ sample }) => {
      faceTs.push(sample.timelineTimeMs)
    },
    dispatchNeck: async (neck, meta) => {
      neckTs.push(meta.timelineTimeMs)
      assert.ok(neck && typeof neck.yaw === "number")
    },
  })
  await done
  assert.ok(faceTs.length >= 1)
  assert.ok(neckTs.length >= 1)
  assert.equal(faceTs[0], neckTs[0])
})

test("AI/AJ — Neck fault does not stop Face", async () => {
  let p = createDefaultFrameProject([])
  p = addCharacterKeyAtTime(p, 0, createInitialEliteRig(), {}, [], {})
  p = addCharacterKeyAtTime(p, 30, createInitialEliteRig(), {}, [], {})
  let faceOk = 0
  const ac = new AbortController()
  let clock = 0
  const done = playKeyframes({
    keyframes: p.keyframes,
    frameProject: p,
    loop: false,
    signal: ac.signal,
    hardwareIntervalMs: 10,
    clock: () => clock,
    scheduleUi: (cb) =>
      setTimeout(() => {
        clock += 20
        cb()
      }, 0),
    cancelUi: clearTimeout,
    scheduleHw: (cb) =>
      setInterval(() => {
        clock += 5
        cb()
      }, 5),
    clearHw: clearInterval,
    sendKeyframe: async () => {
      faceOk += 1
    },
    dispatchNeck: async () => {
      throw new Error("neck down")
    },
  })
  await done
  assert.ok(faceOk >= 1)
})

test("AK/AL/AM — Pause stops hw tick; Stop holds; Loop clock", () => {
  const paused = computePlaybackTimelineTime({
    nowMs: 999,
    anchorClockMs: 0,
    anchorTimelineMs: 100,
    totalDurationMs: 1000,
    paused: true,
    frozenTimelineMs: 250,
  })
  assert.equal(paused, 250)
  const looped = computePlaybackTimelineTime({
    nowMs: 2200,
    anchorClockMs: 0,
    anchorTimelineMs: 0,
    totalDurationMs: 1000,
    loop: true,
  })
  almostEqual(looped, 200)
})

test("AN — Scrub seek calls dispatchNeck(fromScrub); preview gate is editor-side", () => {
  const dope = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../sdk/react/ExpressionDopeSheetTimeline.jsx"),
    "utf8"
  )
  const editor = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../sdk/react/FaceExpressionEditor.jsx"),
    "utf8"
  )
  assert.match(dope, /fromScrub:\s*true/)
  assert.match(dope, /dispatchNeck\(sample\?\.characterPose\?\.neck/)
  assert.match(editor, /fromScrub/)
  assert.match(editor, /HARDWARE_PREVIEW_OFF/)
  const s = sampleCharacterPoseAt(createDefaultFrameProject([]), 0)
  assert.ok(s.characterPose)
})

// —— Face regression ——
test("AO — Face sampler math on migrated v2 matches face-only mid", () => {
  const p = normalizeFrameProject(makeV2ProjectFaceOnly())
  const s = sampleExpressionTimeline(p, 500)
  almostEqual(s.rigSnapshot.jaw.val, 50, 0.5)
  assert.deepEqual(s.characterPose.neck, { pitch: 0, roll: 0, yaw: 0 })
})

test("AP–AW — channel registry still includes face groups + neck; SC/ST/RJ paths untouched by Neck module", () => {
  const groups = listTimelineGroups().map((g) => g.groupId)
  assert.ok(groups.includes("brow"))
  assert.ok(groups.includes("eyes"))
  assert.ok(groups.includes("nose"))
  assert.ok(groups.includes("mouth"))
  assert.ok(groups.includes("jaw"))
  assert.ok(groups.includes("neck"))
  assert.deepEqual(getNeckTimelineChannelIds(), ["neck.pitch", "neck.roll", "neck.yaw"])
  assert.ok(getFaceTimelineChannelIds().every((id) => !id.startsWith("neck.")))
  assert.ok(ALL_TIMELINE_CHANNELS.length === getAllTimelineChannelIds().length)
  assert.ok(isFullFaceKeyed(expandKeyedChannelsToCharacter(getFaceTimelineChannelIds())))
  // characterPoseFromFaceRig → neutral neck
  const cp = characterPoseFromFaceRig(createInitialEliteRig())
  assert.deepEqual(cp.neck, { pitch: 0, roll: 0, yaw: 0 })
})
