import { rigValuesFromEliteRig } from "../../../core/faceDofMapper.js"
import { buildEyeBindingDebugRows } from "../../binding/eyeBindingDiagnostics.js"
import {
  DEFAULT_EYE_CALIBRATION,
  snapshotEyeBalanceGains,
} from "../../tracking/eyeReleaseStabilizer.js"
import EyesBindingDebugPanel from "../binding/EyesBindingDebugPanel.jsx"

const EYE_BALANCE_WARN_RATIO = 0.25
const EYE_BALANCE_ERROR_RATIO = 0.4
const EYE_BALANCE_BLINK_THRESHOLD = 25

function eyeCloseMag(outputs, busCommands, controlId) {
  const out = (outputs || []).find((o) => o.sourceChannel === `${controlId}.value`)
  if (!out) return null
  const bus = (busCommands || []).find((c) => c.actuatorKey === out.actuatorKey)
  const target = bus?.targetPosition ?? out.pwmValue
  if (!Number.isFinite(Number(target))) return null
  const center = Number(bus?.installedCenterPosition) || 1500
  return Math.abs(Number(target) - center)
}

function balanceRatio(l, r) {
  const a = Math.abs(Number(l) || 0)
  const b = Math.abs(Number(r) || 0)
  return Math.abs(a - b) / Math.max(a, b, 1)
}

function balanceStatus(ratio) {
  if (ratio > EYE_BALANCE_ERROR_RATIO) return "Error"
  if (ratio > EYE_BALANCE_WARN_RATIO) return "Warning"
  return "OK"
}

function fmt2(v) {
  if (v == null || Number.isNaN(Number(v))) return "0.00"
  return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : "0.00"
}

function eyeServoSummary(outputs) {
  const eye = (outputs || []).filter((o) => {
    const ch = String(o?.sourceChannel || "")
    return ch.startsWith("eyeL.") || ch.startsWith("eyeR.") || ch.startsWith("eye_xy.") || ch.startsWith("eye_l_xy.") || ch.startsWith("eye_r_xy.")
  })
  if (!eye.length) return "—"
  return eye
    .map((o) => `${o.actuatorKey}:${fmt2(o.logicalValue)}(${o.sourceChannel})`)
    .join(" · ")
}

function lipNeutralHint(lipGeometry, jawGeometry, cameraRunning) {
  if (!cameraRunning || !lipGeometry) return null
  const jawOk = !jawGeometry || jawGeometry.neutralReady
  if (!lipGeometry.neutralReady || !jawOk) {
    const skipped = String(lipGeometry.skipped || "")
    if (skipped.includes("waiting-stable")) return "请保持自然闭嘴，等待稳定采样…"
    return "嘴部零点校准中（唇+下颌）：请自然闭嘴约 1 秒"
  }
  if (lipGeometry.driftCorrection?.updated) return "嘴唇零点缓慢校正中"
  return "嘴部零点已完成（唇+下颌）"
}

function deltaSmooth(lipGeometry, key) {
  const ds = lipGeometry?.deltaSmooth
  if (ds && Number.isFinite(Number(ds[key]))) return ds[key]
  if (lipGeometry && Number.isFinite(Number(lipGeometry[key]))) return lipGeometry[key]
  return 0
}

function DataSection({ title, rows }) {
  if (!rows.length) return null
  return (
    <>
      <h3 className="mapping-category-title">{title}</h3>
      {rows.map(([name, value]) => (
        <div key={name} className="mapping-item">
          <span className="mapping-item-key">{name}</span>
          <span className="mapping-item-value">{value}</span>
        </div>
      ))}
    </>
  )
}

function truncateCmd(cmd, max = 72) {
  const s = String(cmd || "")
  if (s.length <= max) return s || "—"
  return `${s.slice(0, max)}…`
}

export default function MappingSummaryCard({
  previewRig,
  mapping,
  lipGeometry = null,
  jawGeometry = null,
  mouthScenarioClassifier = null,
  browGate = null,
  browDebug = null,
  bypassBrowGate = false,
  showDeveloperDebug = false,
  cameraRunning = false,
  onSetLipNeutral,
  driveMode,
  dryRunResult = null,
  bindings = null,
}) {
  const rig = previewRig || {}
  const mapv = mapping && typeof mapping === "object" ? mapping : null
  const k = dryRunResult?.diagnostics?.kinematics

  const mouthRows = [
    ["mouth.sideL", `${fmt2(rig.mouth?.sideL?.x)} / ${fmt2(rig.mouth?.sideL?.y)}`],
    ["mouth.sideR", `${fmt2(rig.mouth?.sideR?.x)} / ${fmt2(rig.mouth?.sideR?.y)}`],
    ["jaw.val", fmt2(rig.jaw?.val)],
    ["jaw.lateral", fmt2(rig.jaw?.lateral)],
    ["noseL/R", `${fmt2(rig.noseL?.val)} / ${fmt2(rig.noseR?.val)}`],
  ]
  if (mapv) mouthRows.push(["mapping.jaw", fmt2(mapv.jaw)])

  const rigControls = rigValuesFromEliteRig(rig)
  const eyeRows = [
    ["raw eyeL up/lo", mapv ? `${fmt2(mapv.eyeLUp)} / ${fmt2(mapv.eyeLLo)}` : "—"],
    ["raw eyeR up/lo", mapv ? `${fmt2(mapv.eyeRUp)} / ${fmt2(mapv.eyeRLo)}` : "—"],
    ["blink L/R", mapv ? `${fmt2(mapv.blinkLeft)} / ${fmt2(mapv.blinkRight)}` : "—"],
    ["final eyeL up/lo", `${fmt2(rig.eyeL?.up)} / ${fmt2(rig.eyeL?.lo)}`],
    ["final eyeR up/lo", `${fmt2(rig.eyeR?.up)} / ${fmt2(rig.eyeR?.lo)}`],
    ["sharedRadar", `${fmt2(rig.sharedRadar?.x)} / ${fmt2(rig.sharedRadar?.y)}`],
    ["eyeL xy", `${fmt2(rig.eyeL?.x)} / ${fmt2(rig.eyeL?.y)}`],
    ["eyeR xy", `${fmt2(rig.eyeR?.x)} / ${fmt2(rig.eyeR?.y)}`],
    [
      "controls eye_*",
      `${fmt2(rigControls.eye_l_up?.value)}/${fmt2(rigControls.eye_l_lo?.value)} · ${fmt2(rigControls.eye_r_up?.value)}/${fmt2(rigControls.eye_r_lo?.value)}`,
    ],
    ["finalServo eye", eyeServoSummary(dryRunResult?.finalServoOutputs)],
    ["device cmd", truncateCmd(dryRunResult?.commandPreview)],
  ]
  if (mapv) {
    eyeRows.push(["map radar", `${fmt2(mapv.sharedRadarX)} / ${fmt2(mapv.sharedRadarY)}`])
  }
  if (showDeveloperDebug && mapv) {
    eyeRows.push(
      ["bias L/R", `${fmt2(mapv.eyeOpenBiasLeft)} / ${fmt2(mapv.eyeOpenBiasRight)}`],
      ["look X/Y", `${fmt2(mapv.eyeLookX)} / ${fmt2(mapv.eyeLookY)}`]
    )
  }

  const eyeBindingRows = buildEyeBindingDebugRows({
    finalServoOutputs: dryRunResult?.finalServoOutputs,
    bindings,
    busCommands: dryRunResult?.busDryRun?.busCommands,
    rigValues: rigControls,
  })
  for (const er of eyeBindingRows) {
    if (er.warning) {
      eyeRows.push([`${er.label} warn`, er.warningHint || er.warning])
    }
  }

  const balanceOutputs = dryRunResult?.finalServoOutputs
  const balanceBus = dryRunResult?.busDryRun?.busCommands
  const magLUp = eyeCloseMag(balanceOutputs, balanceBus, "eye_l_up")
  const magRUp = eyeCloseMag(balanceOutputs, balanceBus, "eye_r_up")
  const magLLo = eyeCloseMag(balanceOutputs, balanceBus, "eye_l_lo")
  const magRLo = eyeCloseMag(balanceOutputs, balanceBus, "eye_r_lo")
  const blinkActive =
    mapv &&
    Number(mapv.blinkLeft) > EYE_BALANCE_BLINK_THRESHOLD &&
    Number(mapv.blinkRight) > EYE_BALANCE_BLINK_THRESHOLD
  const upperRatio = balanceRatio(magLUp, magRUp)
  const lowerRatio = balanceRatio(magLLo, magRLo)
  const upperStatus = blinkActive ? balanceStatus(upperRatio) : "idle"
  const lowerStatus = blinkActive ? balanceStatus(lowerRatio) : "idle"
  const balanceGains = snapshotEyeBalanceGains(DEFAULT_EYE_CALIBRATION)
  const eyeBalanceRows = [
    ["mapping L/R upper", `${fmt2(Math.abs(rig.eyeL?.up))} / ${fmt2(Math.abs(rig.eyeR?.up))}`],
    ["mapping L/R lower", `${fmt2(Math.abs(rig.eyeL?.lo))} / ${fmt2(Math.abs(rig.eyeR?.lo))}`],
    [
      "device close L/R upper",
      magLUp != null || magRUp != null ? `${fmt2(magLUp)} / ${fmt2(magRUp)}` : "—",
    ],
    [
      "device close L/R lower",
      magLLo != null || magRLo != null ? `${fmt2(magLLo)} / ${fmt2(magRLo)}` : "—",
    ],
    [
      "close gain upper L/R",
      `${fmt2(balanceGains.leftUpperCloseGain)} / ${fmt2(balanceGains.rightUpperCloseGain)}`,
    ],
    [
      "close gain lower L/R",
      `${fmt2(balanceGains.leftLowerCloseGain)} / ${fmt2(balanceGains.rightLowerCloseGain)}`,
    ],
    ["upper status", blinkActive ? `${upperStatus} (ratio ${fmt2(upperRatio)})` : "idle（未闭眼）"],
    ["lower status", blinkActive ? `${lowerStatus} (ratio ${fmt2(lowerRatio)})` : "idle（未闭眼）"],
  ]
  if (blinkActive && (upperStatus !== "OK" || lowerStatus !== "OK")) {
    const leftBigger =
      (Number(magLUp) || 0) + (Number(magLLo) || 0) >
      (Number(magRUp) || 0) + (Number(magRLo) || 0)
    eyeBalanceRows.push([
      "advice",
      leftBigger
        ? "左右眼闭合幅度不一致，建议降低左眼 close gain 或提高右眼 close gain。"
        : "左右眼闭合幅度不一致，建议降低右眼 close gain 或提高左眼 close gain。",
    ])
  }

  const bd = browDebug || null
  const browRows = [
    ["browL tip/mid/tail (final)", `${fmt2(rig.browL?.tip)} / ${fmt2(rig.browL?.mid)} / ${fmt2(rig.browL?.tail)}`],
    ["browR tip/mid/tail (final)", `${fmt2(rig.browR?.tip)} / ${fmt2(rig.browR?.mid)} / ${fmt2(rig.browR?.tail)}`],
    [
      "browL raw tip/mid/tail",
      bd?.raw
        ? `${fmt2(bd.raw.browL?.tip)} / ${fmt2(bd.raw.browL?.mid)} / ${fmt2(bd.raw.browL?.tail)}`
        : "—",
    ],
    [
      "browR raw tip/mid/tail",
      bd?.raw
        ? `${fmt2(bd.raw.browR?.tip)} / ${fmt2(bd.raw.browR?.mid)} / ${fmt2(bd.raw.browR?.tail)}`
        : "—",
    ],
  ]
  if (bd?.browStatusHint) {
    browRows.push(["brow status", bd.browStatusHint])
  }
  if (bypassBrowGate) {
    browRows.push(["bypass gate", "ON (debug)"])
  }

  const lipRows = [
    ["rigWrite UL/UR", `${fmt2(mapv?.upperLipLeft ?? rig.mouth?.UL)} / ${fmt2(mapv?.upperLipRight ?? rig.mouth?.UR)}`],
    ["rigWrite LL/LR", `${fmt2(mapv?.lowerLipLeft ?? rig.mouth?.LL)} / ${fmt2(mapv?.lowerLipRight ?? rig.mouth?.LR)}`],
  ]

  const lipNeutralStatus = lipNeutralHint(lipGeometry, jawGeometry, cameraRunning)
  const jawGeoRows = [
    ["jaw", fmt2(rig.jaw?.val)],
    ["input", fmt2(jawGeometry?.raw)],
    ["curve", fmt2(jawGeometry?.curved)],
    ["scenario", jawGeometry?.mouthScenario || "unknown"],
    ["noseMotion", jawGeometry?.noseAnchorMotion ? "yes" : "no"],
    ["frontalPass", jawGeometry?.gateDecision?.frontalPassThrough ? "on" : "off"],
    ["neutralReady", jawGeometry?.neutralReady ? "yes" : "no"],
  ]
  if (showDeveloperDebug && jawGeometry) {
    jawGeoRows.push(
      ["semanticOpen", fmt2(jawGeometry.semanticOpen)],
      ["smoothSem", fmt2(jawGeometry.smoothSemantic)],
      ["skipped", jawGeometry.skipped || "—"]
    )
  }

  const lipGeoRows = []
  if (lipNeutralStatus) lipGeoRows.push(["status", lipNeutralStatus])
  lipGeoRows.push(
    ["upperL", fmt2(deltaSmooth(lipGeometry, "upperL"))],
    ["upperR", fmt2(deltaSmooth(lipGeometry, "upperR"))],
    ["lowerL", fmt2(deltaSmooth(lipGeometry, "lowerL"))],
    ["lowerR", fmt2(deltaSmooth(lipGeometry, "lowerR"))],
    ["scenario", lipGeometry?.mouthScenario || "unknown"],
    ["headLock", lipGeometry?.closedHeadTurnLock?.active ? "on" : "off"],
    ["frontalPass", lipGeometry?.gateDecision?.frontalPassThrough ? "on" : "off"],
    ["neutralReady", lipGeometry?.neutralReady ? "yes" : "no"],
    ["isolation", Number.isFinite(Number(lipGeometry?.isolation)) ? fmt2(lipGeometry.isolation) : "—"]
  )
  const noseAnchor = lipGeometry?.noseAnchor || jawGeometry?.noseAnchor || null
  const cls = mouthScenarioClassifier || null
  const rawEv = cls?.rawMouthEvidence || null
  const headEv = cls?.headMotionEvidence || null
  const noseMotion =
    Boolean(headEv?.noseAnchorMotion) ||
    lipGeometry?.noseAnchorMotion ||
    jawGeometry?.noseAnchorMotion ||
    Boolean(noseAnchor?.motionActive)
  const finalScenario =
    cls?.finalScenario ||
    lipGeometry?.gateDecision?.finalScenario ||
    lipGeometry?.mouthScenario ||
    jawGeometry?.mouthScenario ||
    "unknown"
  const reliableEv = cls?.reliableMouthEvidence || null
  const strongEv = cls?.strongMouthEvidence || null
  const ocGuard = cls?.openCloseGuard || null
  const ial = cls?.immediateArtifactLock || null
  const mouthScenarioRows = [
    ["scenario", finalScenario],
    ["rawMouthScore", rawEv ? fmt2(rawEv.score) : "—"],
    ["rawSrc", rawEv?.source || "—"],
    ["headScore", headEv ? fmt2(headEv.score) : "—"],
    ["noseMotion", noseMotion ? "yes" : "no"],
    ["reliable", reliableEv ? (reliableEv.reliable ? "yes" : "no") : "—"],
    ["reliableSources", reliableEv?.sources?.length ? reliableEv.sources.join(",") : "—"],
    ["strong", strongEv ? (strongEv.active ? "yes" : "no") : "—"],
    ["openClose", ocGuard ? (ocGuard.active ? "on" : "off") : "—"],
    ["artifactLock", ial ? (ial.active ? "on" : ial.vetoedByOpenCloseGuard ? "vetoed" : "off") : "—"],
    ["reason", cls?.decision?.reason || "—"],
    ["frontalPass", lipGeometry?.gateDecision?.frontalPassThrough ? "on" : "off"],
    ["headLock", lipGeometry?.closedHeadTurnLock?.active ? "on" : "off"],
  ]
  if (showDeveloperDebug && cls) {
    mouthScenarioRows.push(
      ["candidate", `${cls.candidateScenario || "—"} (${cls.candidateCount ?? 0}/${cls.requiredConfirmFrames ?? 0})`],
      ["reliableScore", reliableEv ? fmt2(reliableEv.score) : "—"],
      ["lipOnlyArtifact", cls.lipOnlyArtifact ? "yes" : "no"]
    )
    if (ocGuard) {
      mouthScenarioRows.push(
        ["ocHold", `${ocGuard.count ?? 0}/${ocGuard.confirmFrames ?? 0} h${ocGuard.hold ?? 0}`],
        ["ocScale", fmt2(ocGuard.outputScale)]
      )
    }
  }
  if (showDeveloperDebug && noseAnchor) {
    mouthScenarioRows.push(
      ["noseReady", noseAnchor.neutralReady ? "yes" : "no"],
      ["noseScore", fmt2(noseAnchor.motionScore)]
    )
  }

  const bg = browGate || bd?.gate || null
  const browGateRows = [
    ["raw abs max", bd?.raw ? fmt2(Math.max(bd.raw.browL?.absMax ?? 0, bd.raw.browR?.absMax ?? 0)) : bg ? fmt2(bg.browAbsMax) : "—"],
    ["action", bg?.action || bg?.gateAction || "—"],
    ["decision", bg?.decisionReason || "—"],
    ["explicit", bg ? (bg.explicitBrowActive ? "yes" : "no") : "—"],
    ["explicit count", bg ? String(bg.explicitBrowCount ?? 0) : "—"],
    ["strong evidence", bg ? (bg.browStrongEvidence ? "yes" : "no") : "—"],
    ["safe", bg ? (bg.browSafePose ? "yes" : "no") : "—"],
    ["head", bg ? (bg.headMotionLikely ? "yes" : "no") : "—"],
    ["mouth", bg ? (bg.mouthMotionLikely ? "yes" : "no") : "—"],
    ["neutral", bg ? (bg.neutralReady ? "yes" : "no") : "—"],
  ]
  if (showDeveloperDebug && bg) {
    browGateRows.push(
      ["imm. lock", bg.immediateArtifactLock ? "yes" : "no"],
      ["imm. reason", bg.immediateArtifactReason || "—"],
      ["applies to brow", bg.immediateArtifactAppliesToBrow != null ? (bg.immediateArtifactAppliesToBrow ? "yes" : "no") : "—"],
      ["brow artifact lock", bg.browArtifactLock ? "yes" : "no"],
      ["lip-only imm.", bg.lipOnlyImmediateArtifact ? "yes" : "no"],
      ["classifier", bg.classifierReason || "—"],
      ["neutral raw", bg.neutralReadyRaw != null ? (bg.neutralReadyRaw ? "yes" : "no") : "—"],
      ["fallback", bg.neutralFallback ? "yes" : "no"],
      ["scale", fmt2(bg.outputScale ?? bg.suppressScale)]
    )
  }

  return (
    <details className="tp-mapping-fold">
      <summary className="tp-mapping-fold-summary">
        <span className="tp-mapping-fold-label">Mapping Diagnostics (映射数据诊断)</span>
        <span className="tp-mapping-fold-chevron" aria-hidden>
          ▼
        </span>
      </summary>
      <div className="tp-mapping-fold-body">
        <div className="mapping-list-container">
          <DataSection title="Mouth / Jaw" rows={mouthRows} />
          <DataSection title="Eyes Debug" rows={eyeRows} />
          <DataSection title="Eye Balance" rows={eyeBalanceRows} />
          {dryRunResult?.finalServoOutputs?.length ? (
            <EyesBindingDebugPanel
              compact
              title="Eyes Binding"
              finalServoOutputs={dryRunResult.finalServoOutputs}
              bindings={bindings}
              busCommands={dryRunResult?.busDryRun?.busCommands}
              rigValues={rigControls}
            />
          ) : null}
          <DataSection title="BROWS" rows={browRows} />
          <DataSection title="Lip / Tongue (rigWrite)" rows={lipRows} />
          <DataSection title="Mouth Scenario" rows={mouthScenarioRows} />
          <DataSection title="Brow Gate" rows={browGateRows} />
          <DataSection title="Jaw Geometry" rows={jawGeoRows} />
          <DataSection title="Lip Geometry (delta)" rows={lipGeoRows} />

          {cameraRunning && typeof onSetLipNeutral === "function" ? (
            <div className="tp-lip-neutral-row">
              <button
                type="button"
                className="tp-btn tp-btn--secondary tp-btn--compact"
                onClick={onSetLipNeutral}
              >
                Set Mouth Neutral
              </button>
              <p className="hint tp-lip-neutral-hint">
                请保持自然闭嘴约 1 秒，系统会重新校准嘴部（唇+下颌）中性位。
              </p>
            </div>
          ) : null}

          {(driveMode === "dry-run" || driveMode === "device-drive") && dryRunResult ? (
            <>
              <DataSection
                title={driveMode === "device-drive" ? "Device Drive" : "Dry Run"}
                rows={[
                  ["output", dryRunResult.outputMode || "bus-servo"],
                  ["logicalPose", String(Object.keys(dryRunResult.logicalPose || {}).length)],
                  ["actualPose", String(Object.keys(dryRunResult.actualPose || {}).length)],
                  ["command", truncateCmd(dryRunResult.commandPreview)],
                  ["warnings", dryRunResult.warnings?.length ? String(dryRunResult.warnings.length) : "0"],
                  ...(k?.rightMouthCorner
                    ? [["rightMouth PWM", `${k.logicalPwmA ?? "—"} / ${k.logicalPwmB ?? "—"}`]]
                    : []),
                  ...(k?.leftMouthCorner
                    ? [["leftMouth PWM", `${k.logicalPwmA ?? "—"} / ${k.logicalPwmB ?? "—"}`]]
                    : []),
                ]}
              />
              {dryRunResult.busDryRun?.busOutputDebug ? (
                <DataSection
                  title="Bus Servo Output"
                  rows={[
                    [
                      "finalOutputs",
                      String(
                        dryRunResult.busDryRun.busOutputDebug.sourceFrame?.finalServoOutputCount ??
                          dryRunResult.busDryRun.pwmOutputCount ??
                          0
                      ),
                    ],
                    [
                      "commandCount",
                      String(dryRunResult.busDryRun.busOutputDebug.busBuild?.commandCount ?? 0),
                    ],
                    [
                      "skipped",
                      String(dryRunResult.busDryRun.busOutputDebug.busBuild?.skippedCount ?? 0),
                    ],
                    [
                      "sc/st",
                      `${dryRunResult.busDryRun.busOutputDebug.busBuild?.scCount ?? 0}/${dryRunResult.busDryRun.busOutputDebug.busBuild?.stCount ?? 0}`,
                    ],
                  ]}
                />
              ) : null}
              {dryRunResult.busDryRun?.busOutputDebug?.busCommands?.length ? (
                <DataSection
                  title="Bus Commands (top 12)"
                  rows={dryRunResult.busDryRun.busOutputDebug.busCommands.slice(0, 12).map((c) => [
                    `${c.actuatorKey}→#${c.busServoId}`,
                    `lv=${c.logicalValue} pos=${c.targetPosition} ${c.centerMode ?? ""}`,
                  ])}
                />
              ) : null}
              {dryRunResult.busDryRun?.skipped?.length ? (
                <DataSection
                  title="Bus Skipped"
                  rows={dryRunResult.busDryRun.skipped.slice(0, 8).map((s) => [
                    s.actuatorKey ?? `L${s.legacyServoIndex}`,
                    s.reason,
                  ])}
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </details>
  )
}
