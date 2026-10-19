/**
 * Neck Physical Debug — 只读字段映射。
 * - Luvia: neck.state snapshot
 * - Browser SLCAN: transport.getState()（R3.1）
 * - Browser Runtime: host.getSnapshot()（R4 §42）
 * 不改变 protocol；缺失字段显示 "—"。
 */

function dash(v) {
  if (v === null || v === undefined) return "—"
  if (typeof v === "string" && v.trim() === "") return "—"
  return v
}

function formatBool(v) {
  if (v === true) return "true"
  if (v === false) return "false"
  return "—"
}

function formatNum(v, digits = 2) {
  const n = Number(v)
  if (!Number.isFinite(n)) return "—"
  return n.toFixed(digits)
}

function formatJoint(joint) {
  if (!joint || typeof joint !== "object") {
    return { online: "—", enabled: "—", label: "—" }
  }
  const online = formatBool(joint.online)
  const enabled = formatBool(joint.enabled)
  return {
    online,
    enabled,
    label: `${online}/${enabled}`,
  }
}

/**
 * @param {object|null|undefined} neckState — neck.state 消息的 state 对象
 * @returns {object} 面板展示用扁平字段（全部为 string）
 */
export function mapNeckPhysicalDebugView(neckState) {
  const s = neckState && typeof neckState === "object" ? neckState : null
  if (!s) {
    return {
      connected: "—",
      enabled: "—",
      streaming: "—",
      hardwareExec: "—",
      targetPitch: "—",
      targetRoll: "—",
      targetYaw: "—",
      commandLoopTicks: "—",
      last0x32: "—",
      transportVirtual: "—",
      transportChannel: "—",
      safetyLimited: "—",
      safetyReason: "—",
      joint1: "—",
      joint2: "—",
      joint3: "—",
      hasState: false,
    }
  }

  const target = s.targetPose && typeof s.targetPose === "object" ? s.targetPose : null
  const diag = s.diagnostics && typeof s.diagnostics === "object" ? s.diagnostics : null
  const transport = s.transport && typeof s.transport === "object" ? s.transport : null
  const safety = s.safety && typeof s.safety === "object" ? s.safety : null
  const joints = s.joints && typeof s.joints === "object" ? s.joints : null

  const tick = diag?.commandLoopTickCount
  const tickStr = Number.isFinite(Number(tick)) ? String(Math.round(Number(tick))) : "—"

  return {
    connected: formatBool(s.connected),
    enabled: formatBool(s.enabled),
    streaming: formatBool(s.streaming),
    hardwareExec: formatBool(s.hardwareExecutionEnabled),
    targetPitch: formatNum(target?.pitch),
    targetRoll: formatNum(target?.roll),
    targetYaw: formatNum(target?.yaw),
    commandLoopTicks: tickStr,
    last0x32: dash(diag?.last0x32 != null ? String(diag.last0x32) : null),
    transportVirtual: formatBool(transport?.virtual),
    transportChannel: dash(transport?.channel != null ? String(transport.channel) : null),
    safetyLimited: formatBool(safety?.limited),
    safetyReason: dash(safety?.reason != null ? String(safety.reason) : null),
    joint1: formatJoint(joints?.["1"] ?? joints?.[1]).label,
    joint2: formatJoint(joints?.["2"] ?? joints?.[2]).label,
    joint3: formatJoint(joints?.["3"] ?? joints?.[3]).label,
    hasState: true,
  }
}

function formatFrameBrief(frame) {
  if (!frame || typeof frame !== "object") return "—"
  const id = frame.arbitrationId ?? frame.id
  const hex = id != null ? `0x${Number(id).toString(16)}` : "—"
  const dlc = Array.isArray(frame.data) ? frame.data.length : frame.dlc
  const fd = frame.isFd === true ? "FD" : frame.isFd === false ? "CL" : "?"
  return `${hex} dlc=${dlc ?? "—"} ${fd}`
}

/**
 * Map WebSerialSlcanTransport.getState() for Physical Debug (Browser backend).
 * @param {object|null|undefined} transportState
 * @returns {object}
 */
export function mapBrowserSlcanPhysicalDebugView(transportState) {
  const s = transportState && typeof transportState === "object" ? transportState : null
  if (!s) {
    return {
      activeBackend: "browser-slcan",
      state: "—",
      serialOpen: "—",
      slcanReady: "—",
      portSelected: "—",
      usbVendorId: "—",
      usbProductId: "—",
      canMode: "—",
      brs: "—",
      baudRate: "—",
      txFrameCount: "—",
      rxFrameCount: "—",
      txByteCount: "—",
      rxByteCount: "—",
      lastTxFrame: "—",
      lastRxFrame: "—",
      lastError: "—",
      motorControl: "R4 Runtime",
      hasState: false,
    }
  }

  const info = s.portInfo && typeof s.portInfo === "object" ? s.portInfo : null
  const c = s.counters && typeof s.counters === "object" ? s.counters : {}
  const err = s.lastError

  return {
    activeBackend: "browser-slcan",
    state: dash(s.state != null ? String(s.state) : null),
    serialOpen: formatBool(s.serialOpen),
    slcanReady: formatBool(s.slcanReady),
    portSelected: formatBool(s.portSelected),
    usbVendorId:
      info?.usbVendorId != null ? `0x${Number(info.usbVendorId).toString(16)}` : "—",
    usbProductId:
      info?.usbProductId != null ? `0x${Number(info.usbProductId).toString(16)}` : "—",
    canMode: dash(s.canMode != null ? String(s.canMode) : null),
    brs: formatBool(s.brs),
    baudRate: Number.isFinite(Number(s.baudRate)) ? String(s.baudRate) : "—",
    txFrameCount: Number.isFinite(Number(c.txFrames)) ? String(c.txFrames) : "—",
    rxFrameCount: Number.isFinite(Number(c.rxFrames)) ? String(c.rxFrames) : "—",
    txByteCount: Number.isFinite(Number(c.txBytes)) ? String(c.txBytes) : "—",
    rxByteCount: Number.isFinite(Number(c.rxBytes)) ? String(c.rxBytes) : "—",
    lastTxFrame: formatFrameBrief(s.lastTxFrame),
    lastRxFrame: formatFrameBrief(s.lastRxFrame),
    lastError: err ? `${err.code || ""} ${err.message || ""}`.trim() || "—" : "—",
    motorControl: "R4 Runtime",
    hasState: true,
  }
}

/**
 * Map Browser Neck Runtime Host snapshot (§42) for Physical Debug.
 * @param {object|null|undefined} runtimeSnap
 * @returns {object}
 */
export function mapBrowserRuntimePhysicalDebugView(runtimeSnap) {
  const s = runtimeSnap && typeof runtimeSnap === "object" ? runtimeSnap : null
  if (!s) {
    return {
      runtimeState: "—",
      enabled: "—",
      estop: "—",
      stale: "—",
      calibratingNeutral: "—",
      calibrationStatus: "—",
      persistedOffsets: "—",
      workingOffsets: "—",
      workerRunning: "—",
      tickHz: "—",
      tickCount: "—",
      jitterMean: "—",
      jitterP95: "—",
      missedTickCount: "—",
      safetyLimited: "—",
      safetyReason: "—",
      physicalTxCount: "—",
      lastWriteOk: "—",
      profileName: "—",
      profileVersion: "—",
      hasState: false,
    }
  }
  const w = s.worker && typeof s.worker === "object" ? s.worker : {}
  const safety = s.safety && typeof s.safety === "object" ? s.safety : {}
  const cmd = s.command && typeof s.command === "object" ? s.command : {}
  const prof = s.profile && typeof s.profile === "object" ? s.profile : {}
  const cal = s.calibration && typeof s.calibration === "object" ? s.calibration : {}
  const po = cal.persistedOffsets || {}
  const wo = cal.workingOffsets || {}
  return {
    runtimeState: dash(s.state != null ? String(s.state) : null),
    enabled: formatBool(s.enabled),
    estop: formatBool(s.estop),
    stale: formatBool(s.stale),
    calibratingNeutral: formatBool(s.calibratingNeutral ?? cal.active),
    calibrationStatus: dash(cal.status != null ? String(cal.status) : null),
    persistedOffsets: `s1=${formatNum(po.side1, 2)} s2=${formatNum(po.side2, 2)}`,
    workingOffsets: `s1=${formatNum(wo.side1, 2)} s2=${formatNum(wo.side2, 2)}`,
    workerRunning: formatBool(w.running),
    tickHz: Number.isFinite(Number(w.tickHz)) ? formatNum(w.tickHz, 1) : "—",
    tickCount: Number.isFinite(Number(w.tickCount)) ? String(Math.round(Number(w.tickCount))) : "—",
    jitterMean: Number.isFinite(Number(w.jitterMean)) ? formatNum(w.jitterMean, 2) : "—",
    jitterP95: Number.isFinite(Number(w.jitterP95)) ? formatNum(w.jitterP95, 2) : "—",
    missedTickCount: Number.isFinite(Number(w.missedTickCount))
      ? String(Math.round(Number(w.missedTickCount)))
      : "—",
    safetyLimited: formatBool(safety.limited),
    safetyReason: dash(safety.reason != null ? String(safety.reason) : null),
    physicalTxCount: Number.isFinite(Number(cmd.physicalTxCount))
      ? String(Math.round(Number(cmd.physicalTxCount)))
      : "—",
    lastWriteOk: formatBool(cmd.lastWriteOk),
    profileName: dash(prof.name != null ? String(prof.name) : prof.loaded ? "loaded" : null),
    profileVersion: dash(prof.version != null ? String(prof.version) : null),
    hasState: true,
  }
}
