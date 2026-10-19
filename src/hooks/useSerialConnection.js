/**
 * 串口连接与通信日志（总线：Feetech SC/ST 或锐捷 RJ_SBUS）。
 * @param {'feetech' | 'rj_sbus' | 'bus'} [transportFamily]
 *   - feetech / bus：SC/ST（默认 1M）
 *   - rj_sbus：锐捷 RJ_SBUS（默认 115200）
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  resolveBusBaudConfig,
  resolveBusTransportByFamily,
} from "../sdk/servoAdapters/busServo/resolveBusTransport.js"

const MAX_LOG_LINES = 120

function serialLogTypeLabel(type) {
  const t = String(type || "").toUpperCase()
  if (t === "RX") return "接收"
  if (t === "TX") return "发送"
  if (t === "ERROR") return "错误"
  if (t === "WARN") return "警告"
  return type
}

function normalizeFamily(transportFamily) {
  if (transportFamily === "rj_sbus") return "rj_sbus"
  return "feetech"
}

export function useSerialConnection(transportFamily = "feetech") {
  const family = normalizeFamily(transportFamily)
  const baudCfg = useMemo(() => resolveBusBaudConfig(family), [family])
  const transport = useMemo(() => resolveBusTransportByFamily(family), [family])

  const [status, setStatus] = useState(() => transport.getStatus())
  const [baudRate, setBaudRate] = useState(baudCfg.defaultBaud)
  const [logs, setLogs] = useState([])

  const appendLog = useCallback((type, message) => {
    setLogs((prev) =>
      [
        {
          id: crypto.randomUUID(),
          type,
          message: String(message ?? ""),
          time: new Date().toLocaleTimeString(),
        },
        ...prev,
      ].slice(0, MAX_LOG_LINES)
    )
  }, [])

  useEffect(() => {
    setBaudRate(baudCfg.defaultBaud)
  }, [baudCfg.defaultBaud, family])

  useEffect(() => {
    transport.setCallbacks({
      onStatus: setStatus,
      onData: null,
      onLog: (log) => {
        appendLog(log.level, log.message)
      },
    })
    setStatus(transport.getStatus())
    return () => transport.setCallbacks({ onStatus: null, onLog: null, onData: null })
  }, [transport, appendLog])

  const handleSelectPort = useCallback(async () => {
    try {
      await transport.selectPort()
    } catch (error) {
      appendLog("ERROR", error.message)
    }
  }, [transport, appendLog])

  const handleOpenPort = useCallback(async () => {
    try {
      const st = transport.getStatus()
      await transport.open({
        baudRate: Number(baudRate) || baudCfg.defaultBaud,
        requestPortIfNeeded: !st.portSelected,
      })
    } catch (error) {
      appendLog("ERROR", error.message)
    }
  }, [transport, baudRate, baudCfg.defaultBaud, appendLog])

  const handleClosePort = useCallback(async () => {
    try {
      await transport.close({ releasePort: false })
    } catch (error) {
      appendLog("ERROR", error.message)
    }
  }, [transport, appendLog])

  const clearLogs = useCallback(() => setLogs([]), [])

  return {
    isBus: true,
    family,
    familyLabel: baudCfg.label,
    transport,
    status,
    baudRate,
    setBaudRate,
    logs,
    clearLogs,
    handleSelectPort,
    handleOpenPort,
    handleClosePort,
    baudOptions: baudCfg.baudOptions,
    serialLogTypeLabel,
  }
}
