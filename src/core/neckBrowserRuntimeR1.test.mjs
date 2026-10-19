/**
 * FaceDEV Browser-Native Neck Runtime R1 — Pure Core tests (A–AB practical subset).
 */
import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createNeutralNeckPose, normalizeNeckPose } from "../sdk/neck/neckPose.js"
import {
  createLuviaReferenceProfile,
  geometryFromProfile,
  importNeckRuntimeProfile,
  exportNeckRuntimeProfile,
  planNeckPose,
  createNeckPlannerState,
  solveIk,
  solveFk,
  mapQs,
  signedRawFromCommandDeg,
  jointSafetyLimiterStep,
  createSafetyLimiterState,
  wrapDeg,
  selectNearest,
} from "../sdk/neck/core/index.js"
import { createNeckBrowserShadow, resolveBrowserCoreShadowEnabled } from "../sdk/neck/neckBrowserShadow.js"
import { createNeckBridgeClient } from "../sdk/neck/neckBridgeClient.js"
import { FACEDEV_NECK_PROTOCOL_VERSION } from "../sdk/neck/neckBridgeProtocol.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, "../../tests/fixtures/neck-luvia-golden-v1.json")

function almostEqual(a, b, eps = 1e-4) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= eps, `expected ${a} ≈ ${b} (eps=${eps})`)
}

function loadFixture() {
  if (!fs.existsSync(FIXTURE)) return null
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"))
}

function profileFromFixture(fixture) {
  const snap = fixture?.meta?.profileSnapshot
  if (!snap) return createLuviaReferenceProfile()
  return createLuviaReferenceProfile({
    geometry: snap.geometry,
    mapping: {
      ...snap.mapping,
      side1: { ...snap.mapping.side1 },
      side2: { ...snap.mapping.side2 },
    },
    safety: snap.safety,
  })
}

function planCase(c, profile) {
  const off = c.input.offsets || { side1: 0, side2: 0 }
  const prof = createLuviaReferenceProfile({
    ...profile,
    mapping: {
      ...profile.mapping,
      side1: { ...profile.mapping.side1, offsetDeg: off.side1 },
      side2: { ...profile.mapping.side2, offsetDeg: off.side2 },
      yaw: { ...profile.mapping.yaw, enabled: c.input.yawEnabled !== false },
    },
  })
  const prev = createNeckPlannerState({
    q1: c.input.previousQ?.q1 ?? 0,
    q2: c.input.previousQ?.q2 ?? 0,
    q3: 0,
    safetyInitialized: true,
  })
  // For golden parity of joints/raw, skip limiter (Luvia pose_to_command is pre-limiter)
  return planNeckPose({
    pose: { pitch: c.input.pitch, roll: c.input.roll, yaw: c.input.yaw },
    profile: prof,
    previousState: prev,
    applySafetyLimiter: false,
  })
}

// ——— A semantic ———
test("A: NeckPose semantic contract", () => {
  const n = createNeutralNeckPose()
  assert.deepEqual(n, { pitch: 0, roll: 0, yaw: 0 })
  const p = normalizeNeckPose({ pitch: 5, roll: -3, yaw: 20 }, { clamp: false })
  assert.equal(p.pitch, 5)
  assert.equal(p.roll, -3)
  assert.equal(p.yaw, 20)
  const profile = createLuviaReferenceProfile()
  assert.equal(profile.semantic.pitchPositive, "NOSE_DOWN")
  assert.equal(profile.semantic.rollPositive, "HEAD_TILT_RIGHT")
  assert.equal(profile.semantic.yawPositive, "HEAD_TURN_LEFT")
})

test("B–F: Neutral / pitch / roll / yaw / combined via planNeckPose", () => {
  const profile = createLuviaReferenceProfile()
  const checks = [
    { pitch: 0, roll: 0, yaw: 0 },
    { pitch: 5, roll: 0, yaw: 0 },
    { pitch: -5, roll: 0, yaw: 0 },
    { pitch: 0, roll: 8, yaw: 0 },
    { pitch: 0, roll: -8, yaw: 0 },
    { pitch: 0, roll: 0, yaw: 30 },
    { pitch: 0, roll: 0, yaw: -30 },
    { pitch: 5, roll: -5, yaw: 10 },
  ]
  for (const pose of checks) {
    const plan = planNeckPose({
      pose,
      profile,
      previousState: createNeckPlannerState({ safetyInitialized: true }),
      applySafetyLimiter: false,
    })
    assert.equal(plan.accepted, true, `expected accept for ${JSON.stringify(pose)}: ${plan.rejectReason}`)
    if (pose.pitch === 0 && pose.roll === 0) {
      almostEqual(plan.joints.q1, 0, 1e-6)
      almostEqual(plan.joints.q2, 0, 1e-6)
    }
    assert.equal(plan.diagnostics.branch, "nearest_continuous")
  }
})

test("G–R: golden parity core cases when fixture present", () => {
  const fixture = loadFixture()
  assert.ok(fixture, "golden fixture must exist (run generate-neck-luvia-golden.py)")
  const profile = profileFromFixture(fixture)
  const wantCats = new Set(["A", "B", "C", "D", "E", "H", "I", "L"])
  const subset = fixture.cases.filter((c) => wantCats.has(c.category))
  assert.ok(subset.length > 20)
  let compared = 0
  for (const c of subset) {
    const plan = planCase(c, profile)
    const ref = c.reference
    assert.equal(plan.accepted, ref.valid, `${c.id} accept mismatch: ${plan.rejectReason} vs ${ref.rejectReason}`)
    if (ref.valid) {
      almostEqual(plan.joints.q1, ref.q1, 1e-4)
      almostEqual(plan.joints.q2, ref.q2, 1e-4)
      almostEqual(plan.joints.q3, ref.q3, 1e-4)
      assert.equal(plan.motorTargets.raw.id1, ref.raw.id1, `${c.id} raw1`)
      assert.equal(plan.motorTargets.raw.id2, ref.raw.id2, `${c.id} raw2`)
      assert.equal(plan.motorTargets.raw.id3, ref.raw.id3, `${c.id} raw3`)
      assert.equal(plan.diagnostics.branch, "nearest_continuous")
    } else {
      assert.ok(plan.rejectReason)
      // exact when same family
      if (ref.rejectReason === "UNREACHABLE" || ref.rejectReason === "YAW_LIMIT_REJECTED") {
        assert.equal(plan.rejectReason, ref.rejectReason, `${c.id} reject`)
      }
    }
    compared += 1
  }
  assert.ok(compared >= 20)
})

test("U: seeded 1000-case golden suite", () => {
  const fixture = loadFixture()
  assert.ok(fixture)
  const profile = profileFromFixture(fixture)
  const randoms = fixture.cases.filter((c) => c.category === "M" || c.category === "N")
  assert.ok(randoms.length >= 1000)
  let fail = 0
  const fails = []
  for (const c of randoms) {
    const plan = planCase(c, profile)
    const ref = c.reference
    let ok = plan.accepted === ref.valid
    if (ok && ref.valid) {
      ok =
        Math.abs(plan.joints.q1 - ref.q1) <= 1e-4 &&
        Math.abs(plan.joints.q2 - ref.q2) <= 1e-4 &&
        plan.motorTargets.raw.id1 === ref.raw.id1 &&
        plan.motorTargets.raw.id2 === ref.raw.id2 &&
        plan.motorTargets.raw.id3 === ref.raw.id3
    } else if (ok && !ref.valid) {
      ok = Boolean(plan.rejectReason)
      if (
        ref.rejectReason === "UNREACHABLE" ||
        ref.rejectReason === "YAW_LIMIT_REJECTED" ||
        ref.rejectReason === "JOINT_LIMIT_REJECTED"
      ) {
        ok = plan.rejectReason === ref.rejectReason
      }
    }
    if (!ok) {
      fail += 1
      if (fails.length < 5) {
        fails.push({
          id: c.id,
          js: { accepted: plan.accepted, reason: plan.rejectReason, q: plan.joints, raw: plan.motorTargets.raw },
          py: ref,
        })
      }
    }
  }
  assert.equal(fail, 0, `golden mismatches: ${JSON.stringify(fails, null, 2)}`)
})

test("I/J: branch continuity path", () => {
  const fixture = loadFixture()
  assert.ok(fixture)
  const profile = profileFromFixture(fixture)
  const pathCases = fixture.cases.filter((c) => c.category === "J")
  assert.ok(pathCases.length >= 3)
  let state = createNeckPlannerState({ safetyInitialized: true })
  for (const c of pathCases) {
    const plan = planNeckPose({
      pose: { pitch: c.input.pitch, roll: c.input.roll, yaw: c.input.yaw },
      profile,
      previousState: state,
      applySafetyLimiter: false,
    })
    if (c.reference.valid) {
      assert.equal(plan.accepted, true, c.id)
      assert.equal(plan.diagnostics.branch, "nearest_continuous")
      almostEqual(plan.joints.q1, c.reference.q1, 1e-4)
      almostEqual(plan.joints.q2, c.reference.q2, 1e-4)
      state = createNeckPlannerState({
        q1: plan.joints.q1,
        q2: plan.joints.q2,
        q3: plan.joints.q3,
        safetyInitialized: true,
      })
    }
  }
})

test("N/O/P/Q/R: mapping signs, motor order, offsets, raw exact", () => {
  const profile = createLuviaReferenceProfile()
  assert.equal(profile.mapping.side1.motorId, 2)
  assert.equal(profile.mapping.side1.qToModuleSign, -1)
  assert.equal(profile.mapping.side2.motorId, 1)
  assert.equal(profile.mapping.side2.qToModuleSign, 1)

  // Formal: ID2=-q1, ID1=+q2
  const m0 = mapQs({
    pitchDeg: 0,
    rollDeg: 0,
    q1Deg: 7.2,
    q2Deg: -3.6,
    yawDeg: 18,
    mapping: profile.mapping,
  })
  assert.equal(m0.valid, true)
  almostEqual(m0.moduleDeg.id2, -7.2)
  almostEqual(m0.moduleDeg.id1, -3.6)
  almostEqual(m0.moduleDeg.id3, 18)
  assert.equal(m0.raw.id2, signedRawFromCommandDeg(-7.2))
  assert.equal(m0.raw.id1, signedRawFromCommandDeg(-3.6))
  assert.equal(m0.raw.id3, signedRawFromCommandDeg(18))

  // zero offsets → raw 0 at q=0
  const mz = mapQs({
    pitchDeg: 0,
    rollDeg: 0,
    q1Deg: 0,
    q2Deg: 0,
    yawDeg: 0,
    mapping: profile.mapping,
  })
  assert.deepEqual(mz.raw, { id1: 0, id2: 0, id3: 0 })

  // non-zero offsets
  const mOff = mapQs({
    pitchDeg: 0,
    rollDeg: 0,
    q1Deg: 2,
    q2Deg: 2,
    yawDeg: 0,
    mapping: {
      ...profile.mapping,
      side1: { ...profile.mapping.side1, offsetDeg: 1.5 },
      side2: { ...profile.mapping.side2, offsetDeg: -1.0 },
    },
  })
  // ID2 = offset1 + (-1)*q1 = 1.5 - 2 = -0.5
  // ID1 = offset2 + (+1)*q2 = -1 + 2 = 1
  almostEqual(mOff.moduleDeg.id2, -0.5)
  almostEqual(mOff.moduleDeg.id1, 1)
  assert.equal(mOff.raw.id2, signedRawFromCommandDeg(-0.5))
  assert.equal(mOff.raw.id1, signedRawFromCommandDeg(1))

  const fixture = loadFixture()
  if (fixture?.meta?.rawRoundingChecks) {
    for (const row of fixture.meta.rawRoundingChecks) {
      assert.equal(signedRawFromCommandDeg(row.commandDeg), row.raw)
    }
  }
})

test("S/T: safety velocity / acceleration ceilings", () => {
  let state = createSafetyLimiterState({ initialized: true })
  // velocity: vmax=10, dt=0.01 → max step 0.1
  let r = jointSafetyLimiterStep({
    target: { q1: 10, q2: 0, q3: 0 },
    previousState: state,
    dt: 0.01,
    maxVelocityDegS: 10,
    maxAccelerationDegS2: 1e6,
    periodS: 0.01,
  })
  assert.equal(r.limited, true)
  assert.equal(r.reason, "VELOCITY_CEILING")
  almostEqual(r.safeTarget.q1, 0.1, 1e-9)
  state = r.nextState

  state = createSafetyLimiterState({ initialized: true, v1: 0 })
  r = jointSafetyLimiterStep({
    target: { q1: 10, q2: 0, q3: 0 },
    previousState: state,
    dt: 0.01,
    maxVelocityDegS: 1e6,
    maxAccelerationDegS2: 20,
    periodS: 0.01,
  })
  assert.equal(r.limited, true)
  assert.equal(r.reason, "ACCELERATION_CEILING")
  // dv_max = 20*0.01=0.2 → v=0.2 → q=0.002
  almostEqual(r.safeTarget.q1, 0.002, 1e-9)
})

test("V: round-trip IK→FK near neutral", () => {
  const profile = createLuviaReferenceProfile()
  const geom = geometryFromProfile(profile)
  for (const pose of [
    { pitch: 0, roll: 0 },
    { pitch: 4, roll: -3 },
    { pitch: -6, roll: 7 },
  ]) {
    const ik = solveIk(geom, {
      pitchDeg: pose.pitch,
      rollDeg: pose.roll,
      previousQ1Deg: 0,
      previousQ2Deg: 0,
    })
    assert.equal(ik.valid, true)
    const fk = solveFk(geom, {
      q1Deg: ik.q1Deg,
      q2Deg: ik.q2Deg,
      previousPitchDeg: pose.pitch,
      previousRollDeg: pose.roll,
    })
    assert.equal(fk.valid, true)
    almostEqual(fk.pitchDeg, pose.pitch, 5e-3)
    almostEqual(fk.rollDeg, pose.roll, 5e-3)
  }
})

test("W/X/Y: core has no DOM / WebSocket / Serial deps (static import scan)", () => {
  const coreDir = path.resolve(__dirname, "../sdk/neck/core")
  const files = fs.readdirSync(coreDir).filter((f) => f.endsWith(".js"))
  const banned = [
    /from\s+['"]react/,
    /document\./,
    /window\./,
    /WebSocket/,
    /navigator/,
    /Worker/,
    /setTimeout|setInterval/,
    /neckBridgeClient/,
  ]
  for (const f of files) {
    const text = fs.readFileSync(path.join(coreDir, f), "utf8")
    for (const re of banned) {
      assert.equal(re.test(text), false, `${f} matched ${re}`)
    }
  }
})

test("Z: existing Luvia Bridge client still importable; shadow default OFF", () => {
  assert.equal(FACEDEV_NECK_PROTOCOL_VERSION, "facedev-neck-v1")
  assert.equal(resolveBrowserCoreShadowEnabled({}), false)
  const client = createNeckBridgeClient({
    fetch: async () => ({ ok: false }),
    WebSocket: class {
      close() {}
    },
  })
  const snap = client.getSnapshot()
  assert.equal(snap.browserCoreShadowEnabled, false)
  assert.equal(snap.lastShadowPlan, null)
  client.disconnect()
})

test("shadow mode plans without hardware send", () => {
  const shadow = createNeckBrowserShadow({ enabled: true, emitMinMs: 0 })
  const obs = shadow.observePose({ pitch: 2, roll: -1, yaw: 5 }, { forceEmit: true })
  assert.ok(obs)
  assert.equal(obs.accepted, true)
  assert.ok(Number.isFinite(obs.q1))
  assert.ok(obs.mappedRaw)
})

test("selectNearest uses abs not wrap; wrapDeg (-180,180]", () => {
  assert.equal(selectNearest([170, -170], 0), 170) // abs: 170 < 170? wait both 170 — first min
  assert.equal(selectNearest([10, -10], 1), 10)
  assert.equal(selectNearest([-10, 10], -1), -10)
  almostEqual(wrapDeg(181), -179)
  almostEqual(wrapDeg(-180), 180)
})

test("profile import/export round-trip preserves non-zero offsets", () => {
  const p = createLuviaReferenceProfile({
    mapping: {
      side1: { motorId: 2, qToModuleSign: -1, offsetDeg: 2.5 },
      side2: { motorId: 1, qToModuleSign: 1, offsetDeg: -1.25 },
    },
  })
  const json = exportNeckRuntimeProfile(p)
  const back = importNeckRuntimeProfile(json)
  assert.equal(back.mapping.side1.offsetDeg, 2.5)
  assert.equal(back.mapping.side2.offsetDeg, -1.25)
})

test("AA/AB: CharacterPose / SC modules remain importable (no R1 break)", async () => {
  const { createNeutralCharacterPose } = await import("./characterPose.js")
  const cp = createNeutralCharacterPose()
  assert.ok(cp.neck)
  assert.equal(cp.neck.pitch, 0)
  // SC/ST/RJ — just ensure frameProject still loads
  const { createDefaultFrameProject } = await import("./frameProject.js")
  const proj = createDefaultFrameProject()
  assert.ok(proj)
})
