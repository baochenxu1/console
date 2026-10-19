/** SC/ST/RJ 总线舵机 UI：logical 0–1000 滑条控制 + 点动调零 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  createServoAdapter,
  PROTOCOL,
  SERVO_MODEL,
  SERVO_MODEL_SPECS,
  applyJogPositionAsCenterOffset,
  applyInstalledCenterFromPosition,
  resetToStandardWindow,
  clearProfileNeutral,
  computeServoTargetFromLogical,
  validateServoProfile,
  CENTER_MODE,
  isInstalledCenterMode,
  INSTALLED_CENTER_BOUNDARY_WARNING,
  getEffectiveSafeWindow,
  checkReadPositionForModel,
  writeLogicalValueWithProfile,
  writePositionWithProfile,
  returnNeutralWithProfile,
  migrateLabProfileOnIdChange,
  LOGICAL_MIN,
  LOGICAL_MAX,
  LOGICAL_CENTER,
  RJ_SBUS_DATA_ID,
  RJ_BAUD_OPTION,
  DEFAULT_RJ_EEPROM_BAUDRATE,
  COMMON_RJ_BAUDRATES,
} from "../sdk/servoAdapters/index.js"
import { resolveBusTransport } from "../sdk/servoAdapters/busServo/resolveBusTransport.js"
import {
  planRjHostMotion,
  commitRjHostMotionSend,
  resetRjHostMotionState,
  patchRjMotionConfig,
  RJ_MOTION_CONFIG,
} from "../sdk/output/rjHostMotionAdapter.js"

function numOr(v, fb) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fb
}

/** 实时拖条：无人为门控；仅在串口忙时合并为最新值，下一帧立刻再发 */
const REALTIME_SEND_MIN_INTERVAL_MS = 0

const JOG_STEPS = [1, 5, 10, 20]

function clampLogicalValue(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return LOGICAL_CENTER
  return Math.min(LOGICAL_MAX, Math.max(LOGICAL_MIN, Math.round(n)))
}

function paintSliderFill(sliderEl, logicalValue) {
  if (!sliderEl) return
  const fill = ((clampLogicalValue(logicalValue) - LOGICAL_MIN) / (LOGICAL_MAX - LOGICAL_MIN)) * 100
  sliderEl.style.setProperty("--slider-fill", `${fill}%`)
}

function busWindowHint(profile) {
  if (isInstalledCenterMode(profile)) {
    return `临时中位模式 · center=${profile.installedCenterPosition} · safe ${profile.installedSafeMinValue}~${profile.installedSafeMaxValue}`
  }
  if (profile.servoModel === SERVO_MODEL.ST32_360_4096) {
    return "标准窗口：ST32 position 1024~3072"
  }
  if (profile.servoModel === SERVO_MODEL.RJ_SBUS_ANGLE || profile.protocol === PROTOCOL.RJ_SBUS) {
    return "标准窗口：RJ 协议 ticks -900～+900（中位 0）↔ 机构 0°～180° / ±90°"
  }
  return "标准窗口：SC position 205~819"
}

function centerModeLabel(profile) {
  if (isInstalledCenterMode(profile)) {
    return "临时中位模式：当前安装位置作为 logical 500"
  }
  return "标准窗口模式：理论中间 180° 安全窗口"
}

/** SC 150° / ST 180° 模型固定机械中位（标准窗口 position） */
function getModelMechanicalCenterTarget(profile) {
  const model = profile?.servoModel
  if (model === SERVO_MODEL.SC_300_1024) {
    const spec = SERVO_MODEL_SPECS[SERVO_MODEL.SC_300_1024]
    return {
      label: `转至 SC 中位 150°`,
      angleDeg: spec.logicalAngleCenterDeg,
      position: spec.logicalPositionCenter,
    }
  }
  if (model === SERVO_MODEL.ST32_360_4096) {
    const spec = SERVO_MODEL_SPECS[SERVO_MODEL.ST32_360_4096]
    return {
      label: `转至 ST 中位 180°`,
      angleDeg: spec.logicalAngleCenterDeg,
      position: spec.logicalPositionCenter,
    }
  }
  if (model === SERVO_MODEL.RJ_SBUS_ANGLE) {
    const spec = SERVO_MODEL_SPECS[SERVO_MODEL.RJ_SBUS_ANGLE]
    return {
      label: `转至 RJ 协议中位 0`,
      angleDeg: spec.logicalAngleCenterDeg,
      position: spec.logicalPositionCenter,
    }
  }
  return null
}

/** 常用：总线 ID 管理（Ping / Scan / Change ID） */
export function BusServoIdManagementSection({
  profile,
  patchProfile,
  labProject,
  persistProject,
  onMessage,
  showPingScan = true,
  showChangeId = true,
  title = "ID 管理",
}) {
  const protocol = profile.protocol
  const transport = useMemo(() => resolveBusTransport(protocol), [protocol])
  const adapter = useMemo(
    () => createServoAdapter(protocol, { transport }),
    [protocol, transport]
  )

  const [scanStart, setScanStart] = useState(0)
  const [scanEnd, setScanEnd] = useState(20)
  const [scanResult, setScanResult] = useState([])
  const [scanning, setScanning] = useState(false)
  const [newIdInput, setNewIdInput] = useState(profile.id + 1)

  useEffect(() => {
    setNewIdInput(profile.id + 1)
  }, [profile.id])

  const log = useCallback(
    (msg, isError = false) => onMessage?.({ text: msg, error: isError }),
    [onMessage]
  )

  const handleScan = useCallback(async () => {
    if (!adapter.scan) {
      log("当前协议不支持 Scan", true)
      return
    }
    setScanning(true)
    try {
      const res = await adapter.scan(numOr(scanStart, 0), numOr(scanEnd, 20))
      const found = res.found || []
      setScanResult(found)
      log(found.length ? `Scan 发现 ${found.length} 个 ID：[${found.join(", ")}]` : "Scan 未发现在线 ID")
    } catch (e) {
      log(e?.message || "Scan 失败", true)
      setScanResult([])
    } finally {
      setScanning(false)
    }
  }, [adapter, scanStart, scanEnd, log])

  const handlePing = useCallback(async () => {
    const res = await adapter.ping(profile.id)
    log(res.ok ? `Ping #${profile.id} OK` : res.error || "Ping 失败", !res.ok)
  }, [adapter, profile.id, log])

  const handleReadId = useCallback(async () => {
    if (!adapter.readId) {
      log("当前协议不支持 Read ID", true)
      return
    }
    const res = await adapter.readId(profile.id)
    log(res.ok ? `Read ID = ${JSON.stringify(res.value)}` : res.error || "失败", !res.ok)
  }, [adapter, profile.id, log])

  const handleChangeId = useCallback(async () => {
    const oldId = profile.id
    const newId = numOr(newIdInput, -1)
    const maxId = protocol === PROTOCOL.RJ_SBUS ? 254 : 252
    if (newId < 0 || newId > maxId || newId === oldId) {
      log(`newId 须在 0..${maxId} 且不同于 oldId`, true)
      return
    }
    if (!adapter.changeId && !adapter.changeServoId) {
      log("当前协议不支持 Change ID", true)
      return
    }
    if (!window.confirm(`危险：Change ID ${oldId} → ${newId}，请确认总线只连接一台舵机。`)) return
    if (!window.confirm(`再次确认 Change ID ${oldId} → ${newId}？`)) return
    const changeFn = adapter.changeId
      ? (a, b) => adapter.changeId(a, b)
      : (a, b) => adapter.changeServoId(a, b)
    const res = await changeFn(oldId, newId)
    if (!res.ok) {
      log(res.error || "Change ID 失败", true)
      return
    }
    log(`Change ID 成功：${oldId} → ${newId}`)
    const migrate = window.confirm(`是否迁移 Profile ${protocol}:${oldId} → ${newId}？`)
    if (migrate) {
      persistProject(migrateLabProfileOnIdChange(labProject, oldId, newId, protocol, { copy: true }))
    }
    patchProfile({ id: newId })
  }, [adapter, profile.id, newIdInput, protocol, labProject, persistProject, patchProfile, log])

  if (!showPingScan && !showChangeId) {
    return null
  }

  return (
    <div className="bus-id-management">
      {title ? <p className="bus-id-management-title">{title}</p> : null}
      {showPingScan ? (
        <>
          <div className="field-group bus-id-management-actions">
            <button type="button" className="btn-outline" onClick={handlePing}>
              Ping ID
            </button>
            <button type="button" className="btn-outline" onClick={handleReadId}>
              Read ID
            </button>
          </div>
          <div className="field-inline bus-id-scan-row">
            <input
              type="number"
              aria-label="扫描起始 ID"
              value={scanStart}
              onChange={(e) => setScanStart(e.target.value)}
            />
            <span>~</span>
            <input
              type="number"
              aria-label="扫描结束 ID"
              value={scanEnd}
              onChange={(e) => setScanEnd(e.target.value)}
            />
            <button type="button" className="btn-outline" onClick={handleScan} disabled={scanning}>
              {scanning ? "扫描中…" : "Scan ID"}
            </button>
          </div>
          <div className="bus-id-scan-result" aria-live="polite">
            {scanning ? (
              <span className="bus-id-scan-result--pending">扫描中…</span>
            ) : scanResult.length > 0 ? (
              <>
                <span className="bus-id-scan-result-label">在线 ID（{scanResult.length}）：</span>
                <span className="bus-id-scan-result-ids">{scanResult.join(", ")}</span>
              </>
            ) : (
              <span className="bus-id-scan-result--empty">尚未扫描，或当前范围内无在线舵机</span>
            )}
          </div>
        </>
      ) : null}
      {showChangeId ? (
        <div className="field-inline bus-id-change-row">
          <span>newId</span>
          <input type="number" value={newIdInput} onChange={(e) => setNewIdInput(e.target.value)} />
          <button type="button" className="btn-text-danger" onClick={handleChangeId}>
            Change ID
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** RJ_SBUS 常驻：舵机 EEPROM 波特率读/写（不自动切换主机串口波特率） */
export function BusServoRjBaudrateSection({ profile, onMessage }) {
  const protocol = profile.protocol
  const transport = useMemo(() => resolveBusTransport(protocol), [protocol])
  const adapter = useMemo(
    () => createServoAdapter(protocol, { transport }),
    [protocol, transport]
  )

  const baudOptions = useMemo(() => {
    const byBps = new Map(
      Object.entries(RJ_BAUD_OPTION).map(([code, bps]) => [Number(bps), Number(code)])
    )
    return COMMON_RJ_BAUDRATES.map((bps) => ({
      bps,
      code: byBps.get(bps) ?? null,
    })).filter((o) => o.code != null)
  }, [])

  const [targetBps, setTargetBps] = useState(DEFAULT_RJ_EEPROM_BAUDRATE)
  const [busy, setBusy] = useState(false)
  const [lastRead, setLastRead] = useState(/** @type {null | { optionCode: number, baudRate: number }} */ (null))

  const log = useCallback(
    (msg, isError = false) => onMessage?.({ text: msg, error: isError }),
    [onMessage]
  )

  if (protocol !== PROTOCOL.RJ_SBUS) {
    return null
  }

  const handleRead = async () => {
    if (!adapter.readBaudrate) {
      log("当前适配器不支持 readBaudrate", true)
      return
    }
    setBusy(true)
    try {
      const res = await adapter.readBaudrate(profile.id)
      if (!res.ok) {
        log(res.error || "读取波特率失败", true)
        setLastRead(null)
        return
      }
      setLastRead({ optionCode: res.optionCode, baudRate: res.baudRate })
      if (COMMON_RJ_BAUDRATES.includes(res.baudRate)) {
        setTargetBps(res.baudRate)
      }
      log(`Read 波特率：选项 ${res.optionCode} → ${res.baudRate}`)
    } catch (e) {
      log(e?.message || "读取波特率异常", true)
    } finally {
      setBusy(false)
    }
  }

  const handleWrite = async () => {
    if (!adapter.writeBaudrate) {
      log("当前适配器不支持 writeBaudrate", true)
      return
    }
    if (
      !window.confirm(
        `写入舵机 #${profile.id} 波特率 → ${targetBps}？\n\n写入后主机串口不会自动切换；若与当前连接波特率不同，请到串口面板手动改波特率后再 Ping 验证。`
      )
    ) {
      return
    }
    setBusy(true)
    try {
      const res = await adapter.writeBaudrate(profile.id, targetBps)
      if (!res.ok) {
        log(res.error || "写入波特率失败", true)
        return
      }
      setLastRead({ optionCode: res.optionCode, baudRate: res.baudRate })
      log(res.message || `已写入波特率 ${res.baudRate}`)
    } catch (e) {
      log(e?.message || "写入波特率异常", true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bus-rj-baudrate">
      <p className="bus-id-management-title">RJ 波特率（舵机 EEPROM）</p>
      <p className="hint-text" style={{ margin: "0 0 8px" }}>
        写入 DATA_ID.BAUDRATE，不自动切换主机串口。改速后请手动切换串口波特率再 Ping。
      </p>
      <div className="field-inline bus-rj-baudrate-row">
        <label htmlFor="rj-baud-target">目标</label>
        <select
          id="rj-baud-target"
          value={targetBps}
          disabled={busy}
          onChange={(e) => setTargetBps(Number(e.target.value))}
        >
          {baudOptions.map((o) => (
            <option key={o.code} value={o.bps}>
              {o.bps}（码 {o.code}）
            </option>
          ))}
        </select>
        <button type="button" className="btn-outline" onClick={handleRead} disabled={busy}>
          读取
        </button>
        <button type="button" className="btn-outline" onClick={handleWrite} disabled={busy}>
          写入下发
        </button>
      </div>
      {lastRead ? (
        <p className="hint-text" style={{ margin: "6px 0 0" }}>
          上次读数：选项 {lastRead.optionCode} → {lastRead.baudRate}
        </p>
      ) : null}
    </div>
  )
}

/**
 * RJ 实时性验证：response_switch（data_id=33）+ 运动 power（默认 600 → 测 0）。
 * power=0 为协议「按上限」；此前写层把 ≤0 误当成缺省并强制 600。
 */
export function BusServoRjResponseSwitchSection({ profile, patchProfile, onMessage }) {
  const protocol = profile.protocol
  const transport = useMemo(() => resolveBusTransport(protocol), [protocol])
  const adapter = useMemo(
    () => createServoAdapter(protocol, { transport }),
    [protocol, transport]
  )
  const [busy, setBusy] = useState(false)
  const [lastValue, setLastValue] = useState(/** @type {null | number} */ (null))

  const effectivePower =
    profile.power != null && profile.power !== "" && Number.isFinite(Number(profile.power))
      ? Math.max(0, Math.round(Number(profile.power)))
      : 600

  const log = useCallback(
    (msg, isError = false) => onMessage?.({ text: msg, error: isError }),
    [onMessage]
  )

  if (protocol !== PROTOCOL.RJ_SBUS) {
    return null
  }

  const handleRead = async () => {
    if (!adapter.readResponseSwitch) {
      log("当前适配器不支持 readResponseSwitch", true)
      return
    }
    setBusy(true)
    try {
      const res = await adapter.readResponseSwitch(profile.id)
      if (!res.ok) {
        log(res.error || "读取 response_switch 失败", true)
        setLastValue(null)
        return
      }
      setLastValue(res.value)
      log(
        `Read response_switch(data_id=33)=${res.value}（${
          res.value === 1 ? "有应答，连续写易滞后" : "无应答，适合实时"
        }）；当前写 power=${effectivePower}`
      )
    } catch (e) {
      log(e?.message || "读取 response_switch 异常", true)
    } finally {
      setBusy(false)
    }
  }

  const handleEnsureOff = async () => {
    if (!adapter.readResponseSwitch || !adapter.writeResponseSwitch) {
      log("当前适配器不支持 response_switch 读写", true)
      return
    }
    setBusy(true)
    try {
      const rd = await adapter.readResponseSwitch(profile.id)
      if (!rd.ok) {
        log(rd.error || "读取 response_switch 失败", true)
        setLastValue(null)
        return
      }
      setLastValue(rd.value)
      if (rd.value === 0) {
        log(`#${profile.id} response_switch 已是 0，无需改。可继续测 power。`)
        return
      }
      if (
        !window.confirm(
          `当前 response_switch=${rd.value}。写入 0（关闭指令应答）以改善连续拖条实时性？`
        )
      ) {
        return
      }
      const wr = await adapter.writeResponseSwitch(profile.id, 0)
      if (!wr.ok) {
        log(wr.error || "写入 response_switch=0 失败", true)
        return
      }
      setLastValue(0)
      log(wr.message || "已写入 response_switch=0")
    } catch (e) {
      log(e?.message || "response_switch 验证异常", true)
    } finally {
      setBusy(false)
    }
  }

  const handleSetPower = (nextPower) => {
    if (!patchProfile) {
      log("无法写入 profile.power", true)
      return
    }
    const p = Math.max(0, Math.round(Number(nextPower)))
    patchProfile({ power: p })
    log(
      `已设 profile.power=${p}${
        p === 0 ? "（协议：按功率上限；用于实时性对比）" : ""
      }。请回舵机控制页拖条验证。`
    )
  }

  return (
    <div className="bus-rj-baudrate">
      <p className="bus-id-management-title">RJ 实时性验证</p>
      <p className="hint-text" style={{ margin: "0 0 8px" }}>
        ① response_switch(data_id=33)：1→0。② 运动 power：当前默认 600，改为 0（协议按上限）再拖条对比。
      </p>
      <div className="field-inline bus-rj-baudrate-row">
        <button type="button" className="btn-outline" onClick={handleRead} disabled={busy}>
          读取应答开关
        </button>
        <button type="button" className="btn-outline" onClick={handleEnsureOff} disabled={busy}>
          若为 1 则改为 0
        </button>
      </div>
      {lastValue != null ? (
        <p className="hint-text" style={{ margin: "6px 0 0" }}>
          response_switch={lastValue}
          {lastValue === 0 ? "（无应答）" : lastValue === 1 ? "（有应答）" : ""}
        </p>
      ) : null}
      <div className="field-inline bus-rj-baudrate-row" style={{ marginTop: 10 }}>
        <span>power={effectivePower}</span>
        <button
          type="button"
          className="btn-outline"
          disabled={busy || effectivePower === 0}
          onClick={() => handleSetPower(0)}
        >
          改 power=0
        </button>
        <button
          type="button"
          className="btn-outline"
          disabled={busy || effectivePower === 600}
          onClick={() => handleSetPower(600)}
        >
          改回 600
        </button>
      </div>
    </div>
  )
}

/** 参数配置右侧：点动调零 + 高级折叠区 */
export function BusServoConfigSection({
  profile,
  patchProfile,
  onSaveProfile,
  onMessage,
  labProject,
  persistProject,
}) {
  const protocol = profile.protocol
  const transport = useMemo(() => resolveBusTransport(protocol), [protocol])
  const adapter = useMemo(
    () => createServoAdapter(protocol, { transport }),
    [protocol, transport]
  )
  const validation = useMemo(() => validateServoProfile(profile), [profile])
  const safetyBlocked = !validation.ok

  const effectiveSafe = useMemo(() => getEffectiveSafeWindow(profile), [profile])
  const logicalCenter = isInstalledCenterMode(profile)
    ? profile.installedCenterPosition
    : profile.logicalPositionCenter
  const offset = profile.centerOffsetTicks || 0
  const safeMin = effectiveSafe.safeMinValue
  const safeMax = effectiveSafe.safeMaxValue
  const installedMode = isInstalledCenterMode(profile)

  const [jogPosition, setJogPosition] = useState(logicalCenter)
  const [jogStep, setJogStep] = useState(10)
  const [lastReadPosition, setLastReadPosition] = useState(null)
  const [manualWritePos, setManualWritePos] = useState("")

  useEffect(() => {
    setJogPosition(logicalCenter + offset)
  }, [logicalCenter, offset, profile.id])

  const log = useCallback(
    (msg, isError = false) => onMessage?.({ text: msg, error: isError }),
    [onMessage]
  )

  const clampJog = useCallback(
    (pos) => Math.min(safeMax, Math.max(safeMin, Math.round(pos))),
    [safeMin, safeMax]
  )

  const sendJogPosition = useCallback(
    async (pos) => {
      const target = clampJog(pos)
      setJogPosition(target)
      const res = await writePositionWithProfile(adapter, profile, target, {
        allowManualWrite: true,
      })
      log(
        res.ok ? `点动 → position ${res.sentTarget ?? target}` : res.error || "点动失败",
        !res.ok
      )
    },
    [adapter, profile, clampJog, log]
  )

  const handleJog = useCallback(
    (delta) => sendJogPosition(jogPosition + delta),
    [jogPosition, sendJogPosition]
  )

  const handleSetMechanicalZero = useCallback(() => {
    try {
      const next = applyJogPositionAsCenterOffset(profile, jogPosition)
      const res = onSaveProfile?.(next) ?? { ok: true, profile: patchProfile(next) }
      if (!res.ok) {
        log(res.error || "保存失败", true)
        return
      }
      const newOffset = jogPosition - logicalCenter
      log(
        `设为机械零位：偏移 ${newOffset > 0 ? "+" : ""}${newOffset}，实际中位 ${jogPosition}`
      )
    } catch (e) {
      log(e.message, true)
    }
  }, [profile, jogPosition, logicalCenter, offset, patchProfile, onSaveProfile, log])

  const handleReadPosition = useCallback(async () => {
    const res = await adapter.readPosition(profile.id)
    if (res.ok && res.value != null) {
      checkReadPositionForModel(profile, res.value).warnings.forEach((w) => log(w))
      setLastReadPosition(res.value)
      setJogPosition(clampJog(res.value))
    }
    log(res.ok ? `ReadPos = ${res.value}` : res.error || "ReadPos 失败", !res.ok)
  }, [adapter, profile, clampJog, log])

  const handleSetInstalledCenter = useCallback(async () => {
    let pos = lastReadPosition
    if (pos == null) {
      const res = await adapter.readPosition(profile.id)
      if (!res.ok) {
        log(res.error || "ReadPos 失败", true)
        return
      }
      pos = res.value
      setLastReadPosition(pos)
    }
    try {
      const next = applyInstalledCenterFromPosition(profile, pos)
      const res = onSaveProfile?.(next) ?? { ok: true, profile: patchProfile(next) }
      if (!res.ok) {
        log(res.error || "保存 profile 失败", true)
        return
      }
      const saved = res.profile ?? next
      const msg = `已设 #${saved.id} position ${pos} 为 logical 500 中位 · centerMode=${saved.centerMode} · safe ${saved.installedSafeMinValue}~${saved.installedSafeMaxValue} · fullRange=${saved.installedCenterFullRangeReachable ? "yes" : "no"}`
      log(msg)
      if (!saved.installedCenterFullRangeReachable) {
        log(INSTALLED_CENTER_BOUNDARY_WARNING, true)
      }
      setJogPosition(pos)
    } catch (e) {
      log(e.message, true)
    }
  }, [adapter, profile, lastReadPosition, patchProfile, onSaveProfile, log])

  const handleManualWrite = useCallback(async () => {
    const raw = numOr(String(manualWritePos).trim(), NaN)
    if (!Number.isFinite(raw)) {
      log("无效 position", true)
      return
    }
    if (raw < safeMin || raw > safeMax) {
      const ok = window.confirm(
        `position ${raw} 超出安全窗口 ${safeMin}~${safeMax}，确认高级手动写入？`
      )
      if (!ok) return
    }
    const res = await writePositionWithProfile(adapter, profile, raw, { allowManualWrite: true })
    log(res.ok ? `手动写入 ${res.sentTarget}` : res.error || "写入失败", !res.ok)
  }, [adapter, profile, manualWritePos, safeMin, safeMax, log])

  const modelCenterTarget = useMemo(() => getModelMechanicalCenterTarget(profile), [profile])

  const handleSendModelMechanicalCenter = useCallback(async () => {
    const target = getModelMechanicalCenterTarget(profile)
    if (!target) {
      return
    }
    const res = await writePositionWithProfile(adapter, profile, target.position, {
      allowManualWrite: true,
    })
    if (res.ok) {
      setJogPosition(clampJog(target.position))
    }
    log(
      res.ok
        ? `#${profile.id} → ${target.angleDeg}° · position ${res.sentTarget ?? target.position}`
        : res.error || "发送失败",
      !res.ok
    )
  }, [adapter, profile, clampJog, log])

  const handleReadStatus = useCallback(
    async (kind) => {
      const map = {
        speed: "readSpeed",
        voltage: "readVoltage",
        temperature: "readTemperature",
        current: "readCurrent",
        moving: "readMoving",
        load: "readLoad",
      }
      const fn = adapter[map[kind]]
      if (!fn) {
        log(`不支持读取 ${kind}`, true)
        return
      }
      const res = await fn(profile.id)
      log(res.ok ? `${kind} = ${res.display ?? res.value}` : res.error || "失败", !res.ok)
    },
    [adapter, profile.id, log]
  )

  return (
    <div className="bus-servo-config">
      <div className="calibration-workbench">
        <p className="hint-text">点动调零</p>

        <div className="jog-controller-pro jog-controller-column">
          <button type="button" className="jog-circle-btn" onClick={() => handleJog(-jogStep)}>
            −
          </button>
          <div className="step-box">
            <select value={jogStep} onChange={(e) => setJogStep(numOr(e.target.value, 10))}>
              {JOG_STEPS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <span className="step-box-label">步进值</span>
          </div>
          <button type="button" className="jog-circle-btn" onClick={() => handleJog(jogStep)}>
            +
          </button>
        </div>

        <div className="calibration-status">
          当前输出：<strong>{jogPosition}</strong>
          {lastReadPosition != null && (
            <>
              {" "}
              · 实际位置：<strong>{lastReadPosition}</strong>
            </>
          )}
        </div>
        <div className="calibration-status" style={{ fontSize: 12, marginTop: 4 }}>
          {centerModeLabel(profile)}
        </div>
        {installedMode ? (
          <div className="calibration-status" style={{ fontSize: 12 }}>
            center={profile.installedCenterPosition} · safe {profile.installedSafeMinValue}~
            {profile.installedSafeMaxValue} · fullRange=
            {profile.installedCenterFullRangeReachable ? "yes" : "no"}
          </div>
        ) : (
          <div className="calibration-status" style={{ fontSize: 12 }}>
            逻辑中位 {logicalCenter} · 偏移 {offset > 0 ? "+" : ""}
            {offset}
          </div>
        )}

        {modelCenterTarget ? (
          <button
            type="button"
            className="btn-outline bus-model-center-btn"
            onClick={handleSendModelMechanicalCenter}
            title={`发送 #${profile.id} 至 position ${modelCenterTarget.position}`}
          >
            {modelCenterTarget.label}
            <span className="bus-model-center-btn-sub">
              pos {modelCenterTarget.position}
            </span>
          </button>
        ) : null}

        <button type="button" className="btn-save-zero" onClick={handleSetInstalledCenter}>
          读取当前位置作为中位
        </button>
        {!installedMode ? (
          <button type="button" className="btn-outline" style={{ marginTop: 8, width: "100%" }} onClick={handleSetMechanicalZero}>
            设为机械零位（标准窗口偏移）
          </button>
        ) : null}
        <button
          type="button"
          className="btn-outline"
          style={{ marginTop: 8, width: "100%" }}
          onClick={() => {
            const cleared = resetToStandardWindow(profile)
            const res = onSaveProfile?.(cleared) ?? { ok: true, profile: patchProfile(cleared) }
            log(res.ok ? "已恢复标准窗口模式" : res.error || "恢复失败", !res.ok)
          }}
        >
          恢复标准窗口模式
        </button>
      </div>

      {profile.centerMode === CENTER_MODE.INSTALLED_CENTER &&
        profile.installedCenterFullRangeReachable === false && (
          <p className="hint-text" style={{ color: "#fbbf24", marginTop: 8 }}>
            ⚠ {INSTALLED_CENTER_BOUNDARY_WARNING}
          </p>
        )}

      {safetyBlocked && (
        <p className="hint-text" style={{ color: "#f87171", marginTop: 12 }}>
          {validation.errors[0]}
        </p>
      )}

      <details className="bus-advanced-section">
        <summary>高级：状态读取 · 手动写入 · 运动参数</summary>
        <div className="bus-advanced-body">
        <div className="config-btn-group bus-advanced-actions">
          <button type="button" className="btn-outline" onClick={handleReadPosition}>
            ReadPos
          </button>
          {["speed", "voltage", "temperature", "current", "moving", "load"].map((k) => (
            <button key={k} type="button" className="btn-outline" onClick={() => handleReadStatus(k)}>
              {k}
            </button>
          ))}
        </div>
        <div className="field-inline" style={{ marginTop: 8 }}>
          <input
            type="number"
            placeholder={`${safeMin}~${safeMax}`}
            value={manualWritePos}
            onChange={(e) => setManualWritePos(e.target.value)}
          />
          <button type="button" className="btn-outline" onClick={handleManualWrite}>
            Write Position
          </button>
        </div>
        {protocol === PROTOCOL.SCSCL || protocol === PROTOCOL.RJ_SBUS ? (
          <div className="field" style={{ marginTop: 8 }}>
            <label>{protocol === PROTOCOL.RJ_SBUS ? "time (RJ, ms)" : "time (SC)"}</label>
            <input
              type="number"
              value={profile.time ?? 0}
              onChange={(e) => patchProfile({ time: numOr(e.target.value, 0) })}
            />
          </div>
        ) : null}
        <div className="field-group" style={{ marginTop: 8 }}>
          <div className="field">
            <label>speed</label>
            <input
              type="number"
              value={profile.speed ?? 0}
              onChange={(e) => patchProfile({ speed: numOr(e.target.value, 0) })}
            />
          </div>
          {protocol === PROTOCOL.SMS_STS ? (
            <div className="field">
              <label>acc</label>
              <input
                type="number"
                value={profile.acc ?? 0}
                onChange={(e) => patchProfile({ acc: numOr(e.target.value, 0) })}
              />
            </div>
          ) : null}
        </div>
        </div>
      </details>
    </div>
  )
}

/** 导出窗口提示供左栏使用 */
export { busWindowHint, centerModeLabel }

/** SC/ST/RJ 舵机控制区（logicalValue 0~1000） */
export function BusServoControlSection({ profile, protocolControl, onMessage, onLastCommand }) {
  const protocol = profile.protocol
  const transport = useMemo(() => resolveBusTransport(protocol), [protocol])
  const adapter = useMemo(
    () => createServoAdapter(protocol, { transport }),
    [protocol, transport]
  )
  const validation = useMemo(() => validateServoProfile(profile), [profile])
  const driveBlocked = !validation.ok

  const [logicalValue, setLogicalValue] = useState(LOGICAL_CENTER)
  const [manualLogical, setManualLogical] = useState(LOGICAL_CENTER)
  const [lastReadPosition, setLastReadPosition] = useState(null)

  const realtimeTimerRef = useRef(null)
  const realtimePendingRef = useRef(null)
  const realtimeBusyRef = useRef(false)
  const realtimeLastSentAtRef = useRef(0)
  const realtimeLastSentValueRef = useRef(null)
  const flushRealtimeSendRef = useRef(null)
  const sliderRef = useRef(null)
  const sliderDraggingRef = useRef(false)

  const preview = useMemo(
    () => computeServoTargetFromLogical(profile, logicalValue),
    [profile, logicalValue]
  )

  const log = useCallback(
    (msg, cmd = "", isError = false) => {
      onMessage?.({ text: msg, error: isError })
      if (cmd) onLastCommand?.(cmd)
    },
    [onMessage, onLastCommand]
  )

  const connected = transport.getStatus().connected
  const offset = profile.centerOffsetTicks || 0
  const installedMode = isInstalledCenterMode(profile)
  const centerPos = installedMode ? profile.installedCenterPosition : profile.logicalPositionCenter + offset

  const sendLogicalValue = useCallback(
    async (lv, { quiet = false } = {}) => {
      if (driveBlocked) {
        if (!quiet) log(validation.errors[0] || "Profile 校验失败", "", true)
        console.warn("[BusServoControl] driveBlocked, skipping send. errors:", validation.errors)
        return { ok: false, deferred: false }
      }
      const v = Math.min(LOGICAL_MAX, Math.max(LOGICAL_MIN, Math.round(Number(lv))))
      const plan = computeServoTargetFromLogical(profile, v)
      if (!quiet) {
        setLogicalValue(v)
      }

      const isRj = profile.protocol === PROTOCOL.RJ_SBUS
      let writeProfile = profile
      let motionPlan = null

      if (isRj) {
        /* Phase1：RJ 经 Host Motion Adapter 生成 timeMs，不再固定 time=0 */
        const rawPower = profile.power
        const hasPower = rawPower != null && rawPower !== ""
        const power = hasPower && Number.isFinite(Number(rawPower))
          ? Math.max(0, Math.round(Number(rawPower)))
          : undefined
        motionPlan = planRjHostMotion({
          servoId: profile.id,
          targetPosition: plan.targetPosition,
          protocol: "RJ",
          power,
        })
        if (!motionPlan.ok) {
          if (!quiet) log(motionPlan.error || "RJ Motion 规划失败", "", true)
          return { ok: false, deferred: false }
        }
        if (motionPlan.deferred) {
          return { ok: false, deferred: true, retryAfterMs: motionPlan.retryAfterMs }
        }
        writeProfile = {
          ...profile,
          time: motionPlan.timeMs,
          ...(power !== undefined ? { power } : {}),
        }
      } else if (quiet) {
        /* SC/ST 拖条：保持原 time=0 尽快到位 */
        writeProfile = {
          ...profile,
          time: 0,
          speed: Number(profile.speed) || 0,
          acc: Number(profile.acc) || 0,
        }
      }

      const res = await writeLogicalValueWithProfile(adapter, writeProfile, v, { waitAck: false })
      if (isRj && motionPlan && res.ok) {
        commitRjHostMotionSend(profile.id, motionPlan)
      }
      console.debug(
        `[BusServoControl] logical=${v} → target=${res.sentTarget ?? plan.targetPosition}` +
          (isRj && motionPlan ? ` time=${motionPlan.timeMs}ms` : "") +
          ` ok=${res.ok} err=${res.error || ""}`
      )
      const cmd = isRj && motionPlan
        ? `BUS logical=${v} pos=${res.sentTarget ?? plan.targetPosition} time=${motionPlan.timeMs}`
        : `BUS logical=${v} pos=${res.sentTarget ?? plan.targetPosition}`
      if (!quiet) {
        log(
          res.ok
            ? isRj && motionPlan
              ? `logical=${v} → position ${res.sentTarget ?? plan.targetPosition} (RJ time=${motionPlan.timeMs}ms)`
              : `logical=${v} → position ${res.sentTarget ?? plan.targetPosition}`
            : res.error || "发送失败",
          cmd,
          !res.ok
        )
      }
      return { ok: Boolean(res.ok), deferred: false }
    },
    [adapter, profile, driveBlocked, validation.errors, log]
  )

  const scheduleRealtimeFlush = useCallback((delayMs = 0) => {
    if (realtimeTimerRef.current != null) return
    if (delayMs > 0) {
      realtimeTimerRef.current = window.setTimeout(() => {
        realtimeTimerRef.current = null
        void flushRealtimeSendRef.current?.()
      }, delayMs)
      return
    }
    // 跟显示刷新对齐，避免 setTimeout(0) 堆积造成卡顿
    realtimeTimerRef.current = window.requestAnimationFrame(() => {
      realtimeTimerRef.current = null
      void flushRealtimeSendRef.current?.()
    })
  }, [])

  const clearRealtimeSchedule = useCallback(() => {
    if (realtimeTimerRef.current == null) return
    // rAF 与 timeout 共用同一 ref：优先 cancelAnimationFrame，再 clearTimeout
    window.cancelAnimationFrame(realtimeTimerRef.current)
    window.clearTimeout(realtimeTimerRef.current)
    realtimeTimerRef.current = null
  }, [])

  const flushRealtimeSend = useCallback(async () => {
    if (realtimeBusyRef.current) return
    const value = realtimePendingRef.current
    if (value === null || value === undefined) return
    if (value === realtimeLastSentValueRef.current) {
      realtimePendingRef.current = null
      return
    }

    const isRj = profile.protocol === PROTOCOL.RJ_SBUS
    const minIntervalMs = isRj
      ? Math.max(0, Number(RJ_MOTION_CONFIG.minSendIntervalMs) || 0)
      : REALTIME_SEND_MIN_INTERVAL_MS

    const elapsed = Date.now() - realtimeLastSentAtRef.current
    if (minIntervalMs > 0 && realtimeLastSentAtRef.current > 0 && elapsed < minIntervalMs) {
      scheduleRealtimeFlush(minIntervalMs - elapsed)
      return
    }

    realtimePendingRef.current = null
    realtimeBusyRef.current = true
    const sentValue = value
    try {
      const res = await sendLogicalValue(sentValue, { quiet: true })
      if (res?.deferred) {
        /* 间隔未到：保留 pending，按 retryAfter 再发 */
        realtimePendingRef.current = sentValue
        realtimeLastSentValueRef.current = null
        scheduleRealtimeFlush(res.retryAfterMs || minIntervalMs || 1)
        return
      }
      realtimeLastSentAtRef.current = Date.now()
      if (res?.ok) {
        realtimeLastSentValueRef.current = sentValue
      } else {
        realtimeLastSentValueRef.current = null
      }
    } finally {
      realtimeBusyRef.current = false
      if (realtimePendingRef.current !== null && realtimePendingRef.current !== undefined) {
        scheduleRealtimeFlush(0)
      }
    }
  }, [sendLogicalValue, scheduleRealtimeFlush, profile.protocol])
  flushRealtimeSendRef.current = flushRealtimeSend

  const requestRealtimeSend = useCallback(
    (value) => {
      realtimePendingRef.current = value
      if (realtimeBusyRef.current) return
      scheduleRealtimeFlush(0)
    },
    [scheduleRealtimeFlush]
  )

  useEffect(
    () => () => {
      clearRealtimeSchedule()
    },
    [clearRealtimeSchedule]
  )

  /* 切换舵机 ID 时重置旧 ID 的 Host Motion 估计，避免串台 */
  const prevRjServoIdRef = useRef(null)
  useEffect(() => {
    if (profile.protocol !== PROTOCOL.RJ_SBUS) {
      prevRjServoIdRef.current = null
      return
    }
    const prev = prevRjServoIdRef.current
    if (prev != null && prev !== profile.id) {
      resetRjHostMotionState(prev)
    }
    prevRjServoIdRef.current = profile.id
    /* Phase1 参数验证：控制台可调 window.__RJ_MOTION__.patch({ velocityRatio: 0.7 }) */
    if (typeof window !== "undefined") {
      window.__RJ_MOTION__ = {
        config: RJ_MOTION_CONFIG,
        patch: patchRjMotionConfig,
        reset: resetRjHostMotionState,
      }
    }
  }, [profile.id, profile.protocol])

  const moveLogical = useCallback(
    async (lv) => {
      clearRealtimeSchedule()
      realtimePendingRef.current = null
      realtimeLastSentValueRef.current = clampLogicalValue(lv)
      await sendLogicalValue(lv, { quiet: false })
    },
    [sendLogicalValue, clearRealtimeSchedule]
  )

  const handleSliderInput = useCallback(
    (event) => {
      const sliderEl = event.target
      const raw = sliderEl?.value ?? sliderRef.current?.value ?? LOGICAL_CENTER
      const v = clampLogicalValue(raw)
      paintSliderFill(sliderEl, v)
      requestRealtimeSend(v)
    },
    [requestRealtimeSend]
  )

  const handleSliderCommit = useCallback(async () => {
    sliderDraggingRef.current = false
    clearRealtimeSchedule()
    const currentValue = clampLogicalValue(numOr(sliderRef.current?.value, logicalValue))
    const pending = realtimePendingRef.current ?? currentValue
    realtimePendingRef.current = null
    realtimeLastSentValueRef.current = clampLogicalValue(pending)
    await sendLogicalValue(pending, { quiet: false })
  }, [logicalValue, sendLogicalValue, clearRealtimeSchedule])

  useEffect(() => {
    if (sliderDraggingRef.current) return
    if (!sliderRef.current) return
    sliderRef.current.value = String(logicalValue)
    paintSliderFill(sliderRef.current, logicalValue)
  }, [logicalValue])

  const handleReturnNeutral = useCallback(async () => {
    setLogicalValue(LOGICAL_CENTER)
    const res = await returnNeutralWithProfile(adapter, profile)
    log(
      res.ok ? res.message || `回标准中点 logical 500 → position ${centerPos}` : res.error || "失败",
      `BUS logical=500 pos=${centerPos}`,
      !res.ok
    )
  }, [adapter, profile, centerPos, log])

  const handleStop = useCallback(async () => {
    const res = await adapter.stop(profile.id)
    log(res.ok ? `Stop #${profile.id}` : res.error || "失败", "", !res.ok)
  }, [adapter, profile.id, log])

  const handleStopAll = useCallback(async () => {
    if (adapter.stopAll) {
      const res = await adapter.stopAll()
      log(res.ok ? "Stop All" : res.error || "失败", "", !res.ok)
    } else {
      await handleStop()
    }
  }, [adapter, handleStop, log])

  const handleReadPosition = useCallback(async () => {
    const res = await adapter.readPosition(profile.id)
    if (res.ok) {
      setLastReadPosition(res.value)
      checkReadPositionForModel(profile, res.value).warnings.forEach((w) => log(w))
    }
    log(res.ok ? `ReadPos=${res.value}` : res.error || "失败", "", !res.ok)
  }, [adapter, profile, log])

  const handleRjDiagnoseLimits = useCallback(async () => {
    if (protocol !== PROTOCOL.RJ_SBUS || !adapter.readData) {
      log("仅 RJ_SBUS 支持角度限位诊断", "", true)
      return
    }
    const id = profile.id
    const keys = [
      ["SERVO_STATUS", RJ_SBUS_DATA_ID.SERVO_STATUS],
      ["OVERLOAD", RJ_SBUS_DATA_ID.OVERLOAD_PROTECTION_STATUS],
      ["PO_LOCK", RJ_SBUS_DATA_ID.PO_LOCK_SWITCH],
      ["LIMIT_HIGH", RJ_SBUS_DATA_ID.ANGLE_LIMIT_HIGH],
      ["LIMIT_LOW", RJ_SBUS_DATA_ID.ANGLE_LIMIT_LOW],
      ["MID_OFFSET", RJ_SBUS_DATA_ID.ANGLE_MID_OFFSET],
    ]
    const parts = []
    for (const [name, dataId] of keys) {
      const res = await adapter.readData(id, dataId)
      parts.push(res.ok ? `${name}=${res.value}` : `${name}=ERR`)
    }
    log(`RJ 诊断：${parts.join(" · ")}`)
  }, [adapter, profile.id, protocol, log])

  return (
    <div className="bus-servo-control">
      <section className="monitor-row" aria-label="总线舵机反馈">
        <div className="monitor-row-top">
          {protocolControl}
          <div className="sub-readout-group">
            <div className="readout-badge">
              <span className="badge-k">机构角度</span>
              <span className="badge-v">{(preview.angleDeg ?? 0).toFixed(1)}°</span>
            </div>
            <div className="readout-badge">
              <span className="badge-k">目标输出</span>
              <span className="badge-v">{preview.targetPosition}</span>
            </div>
            <div className="readout-badge">
              <span className="badge-k">实际位置</span>
              <span className="badge-v">{lastReadPosition ?? "—"}</span>
            </div>
            <div className="readout-badge">
              <span className="badge-k">安装中位</span>
              <span className="badge-v">
                {installedMode && profile.installedCenterPosition != null
                  ? profile.installedCenterPosition
                  : "—"}
              </span>
            </div>
          </div>
        </div>
        <div className="main-readout main-readout--primary">
          <span className="readout-label">逻辑位置</span>
          <span className="readout-value">{logicalValue}</span>
        </div>
      </section>

      <p className="hint-text">
        {centerModeLabel(profile)}
        {installedMode
          ? ` · center=${profile.installedCenterPosition} · safe ${profile.installedSafeMinValue}~${profile.installedSafeMaxValue}`
          : ""}
        {!connected ? " · 串口未连接" : ""}
      </p>
      {installedMode && profile.installedCenterFullRangeReachable === false && (
        <p className="hint-text" style={{ color: "#fbbf24" }}>
          ⚠ {INSTALLED_CENTER_BOUNDARY_WARNING}
          {profile.installedReachableMinLogical != null && (
            <>
              {" "}
              · 可达 logical {profile.installedReachableMinLogical}~{profile.installedReachableMaxLogical}
            </>
          )}
        </p>
      )}
      {preview.isClamped && preview.warning && (
        <p className="hint-text" style={{ color: "#fbbf24" }}>
          clamp：{preview.warning}
        </p>
      )}

      <section className="setter-bay card" aria-label="逻辑位置滑块">
        <div className="slider-wrapper">
          <input
            ref={sliderRef}
            type="range"
            className="huge-slider"
            style={{ "--slider-fill": `${((LOGICAL_CENTER - LOGICAL_MIN) / (LOGICAL_MAX - LOGICAL_MIN)) * 100}%` }}
            defaultValue={logicalValue}
            min={LOGICAL_MIN}
            max={LOGICAL_MAX}
            step={1}
            disabled={driveBlocked}
            onPointerDown={() => {
              sliderDraggingRef.current = true
            }}
            onInput={handleSliderInput}
            onMouseUp={handleSliderCommit}
            onTouchEnd={handleSliderCommit}
            onPointerUp={handleSliderCommit}
          />
          <div className="slider-labels">
            <span>0 (机构0°)</span>
            <span className="axis-title">逻辑轴 0~1000 · 中位±90°</span>
            <span>1000 (机构180°)</span>
          </div>
        </div>

        <div className="input-setter-stack">
          <div className="input-with-btn pro-setter">
            <input
              type="number"
              min={LOGICAL_MIN}
              max={LOGICAL_MAX}
              value={manualLogical}
              onChange={(e) => setManualLogical(numOr(e.target.value, LOGICAL_CENTER))}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={driveBlocked}
              onClick={() => moveLogical(manualLogical)}
            >
              跳转设定
            </button>
          </div>
        </div>
      </section>

      <section className="command-footer" aria-label="执行指令">
        <button
          type="button"
          className="btn-hero-action"
          disabled={driveBlocked}
          onClick={handleReturnNeutral}
        >
          回标准中点（500）
        </button>

        <div className="safety-btns">
          <button type="button" className="btn-mini-ghost" onClick={handleReadPosition}>
            ReadPos
          </button>
          {protocol === PROTOCOL.RJ_SBUS ? (
            <button type="button" className="btn-mini-ghost" onClick={handleRjDiagnoseLimits}>
              RJ诊断限位
            </button>
          ) : null}
          <button type="button" className="btn-mini-ghost" onClick={handleStop}>
            停止当前 · ID {profile.id}
          </button>
          <button type="button" className="btn-mini-ghost btn-danger-text safety-btn--wide" onClick={handleStopAll}>
            紧急停止全部
          </button>
        </div>
      </section>
    </div>
  )
}
