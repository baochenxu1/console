import { sendBusServoOutputs } from "../adapters/busServoOutputAdapter.js"
import { OUTPUT_MODES } from "../../trackingPreview/trackingPreviewConstants.js"
import {
  getActiveBusTransport,
  getActiveBusTransportLabel,
  getStoredBusTransportFamily,
  isSharedBusWireConnected,
  resolveBusBaudConfig,
  evaluateBusCommandsPortGate,
} from "../../servoAdapters/busServo/resolveBusTransport.js"
import { evaluateBindingOutputGates } from "./evaluateBindingOutputGates.js"
import { formatBusCommandsPreview } from "../adapters/busServoOutputAdapter.js"
import { buildBusCommandsFromFinalOutputs } from "../adapters/busServoOutputAdapter.js"
import { loadActuatorProfiles } from "../loadActuatorProfiles.js"

/**
 * 绑定工作台真实下发（仅 Bus Servo）；Preview 模式仅返回 dry-run。
 * Face Rig 默认 / 显式 txMode:"single-write"：
 *   SC/ST → 历史逐台写（不改飞特实现）；RJ → Motion + Batch TX。
 * Tracking 等可显式传 txMode:"hybrid"（SC SyncWrite 0x83 + ST single-write + RJ Batch）。
 * 舵机配置每次下发都现读 storage，保证面部绑定用最新总线 profile。
 * 串口：RJ@1M 与 ST 共总线，开一次口即可；同一 UART 切换报文混发。
 */
export async function dispatchBindingWorkbenchOutputs({
  finalServoOutputs,
  outputMode = "preview",
  driveArmed = false,
  configs = [],
  actuatorProfiles = null,
  profilesReady = null,
  timeMs = 40,
  busSerialConnected = isSharedBusWireConnected(),
  openBusIfNeeded = true,
  baudRate = null,
  txMode = "single-write",
  quiet = false,
  rjMotionConfig = null,
} = {}) {
  void configs
  void OUTPUT_MODES

  const family = getStoredBusTransportFamily()
  const familyLabel = getActiveBusTransportLabel(family)
  const transport = getActiveBusTransport(family)
  const effectiveBaud =
    Number.isFinite(Number(baudRate)) && Number(baudRate) > 0
      ? Math.round(Number(baudRate))
      : resolveBusBaudConfig(family).defaultBaud

  const latest = loadActuatorProfiles()
  const effectiveProfiles = Array.isArray(actuatorProfiles)
    ? actuatorProfiles
    : latest.actuatorProfiles
  const effectiveReady =
    profilesReady == null ? latest.allowRealSend : Boolean(profilesReady)

  const gates = evaluateBindingOutputGates({
    driveArmed,
    outputMode,
    busSerialConnected,
    busFamilyLabel: familyLabel,
    profilesReady: effectiveReady,
    finalOutputCount: finalServoOutputs?.length ?? 0,
  })

  const busBuilt = buildBusCommandsFromFinalOutputs(finalServoOutputs, effectiveProfiles)
  /* 仅当显式传入有限 timeMs 时覆盖；保留 profile 默认 time */
  if (Number.isFinite(Number(timeMs)) && busBuilt.commands?.length) {
    const t = Math.max(0, Math.round(Number(timeMs)))
    for (const c of busBuilt.commands) {
      c.time = t
    }
  }
  const commandPreview = formatBusCommandsPreview(busBuilt.commands)

  if (outputMode === "preview") {
    return {
      ok: true,
      dryRun: true,
      gates,
      commandPreview,
      busBuilt,
      message: gates.reason === "no-final-outputs" ? "无可下发输出" : "Preview Only（未发送）",
    }
  }

  if (!gates.canSend) {
    return {
      ok: false,
      dryRun: false,
      gates,
      commandPreview,
      busBuilt,
      error: gates.note || gates.reason,
    }
  }

  const portGate = evaluateBusCommandsPortGate(busBuilt.commands || [])
  if (!portGate.ok) {
    return {
      ok: false,
      dryRun: false,
      gates: {
        ...gates,
        canSend: false,
        note: portGate.reason,
        reason: "bus-port-gate",
      },
      commandPreview,
      busBuilt,
      error: portGate.reason,
    }
  }

  if (!transport.getStatus()?.connected && openBusIfNeeded) {
    try {
      await transport.open({ baudRate: effectiveBaud, requestPortIfNeeded: true })
    } catch (e) {
      return {
        ok: false,
        gates,
        error: e?.message || `${familyLabel} 串口未连接`,
        commandPreview,
        busBuilt,
      }
    }
  }

  const sendRes = await sendBusServoOutputs(finalServoOutputs, effectiveProfiles, {
    txMode,
    commandTimeMs: Number.isFinite(Number(timeMs)) ? Math.max(0, Math.round(Number(timeMs))) : null,
    rjMotionConfig,
  })

  return {
    ok: sendRes.ok,
    dryRun: false,
    gates,
    commandPreview,
    busBuilt: sendRes.built ?? busBuilt,
    busSend: sendRes.send,
    error: sendRes.error,
    message: quiet
      ? ""
      : sendRes.ok
        ? ""
        : sendRes.error,
    sent: sendRes.ok,
  }
}
