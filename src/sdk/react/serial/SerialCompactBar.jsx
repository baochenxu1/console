import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  BUS_TRANSPORT_FAMILY_OPTIONS,
  BUS_TRANSPORT_FAMILY_STORAGE_KEY,
  normalizeBusTransportFamily,
  resolveBusBaudConfig,
  resolveBusTransportByFamily,
} from "../../servoAdapters/busServo/resolveBusTransport.js"
import { readJsonStorage, writeJsonStorage } from "../../../utils/storage.js"

/**
 * 紧凑串口条：开一次口。
 * RJ 机型与飞特 ST 共总线（默认 1M），同一 UART 上切换 RJ / Feetech 报文。
 */
export default function SerialCompactBar({
  transportFamily: transportFamilyProp,
  onTransportFamilyChange,
  baudRate: _baudRateProp,
  onBaudRateChange,
  transportMode: _transportModeProp,
  onTransportModeChange,
  showProtocolSwitch: _showProtocolSwitch = false,
}) {
  void _baudRateProp
  void _transportModeProp
  void _showProtocolSwitch
  void onTransportModeChange

  const [internalFamily, setInternalFamily] = useState(() =>
    normalizeBusTransportFamily(
      transportFamilyProp ??
        readJsonStorage(BUS_TRANSPORT_FAMILY_STORAGE_KEY, "feetech")
    )
  )
  const family = normalizeBusTransportFamily(transportFamilyProp ?? internalFamily)
  const baudCfg = useMemo(() => resolveBusBaudConfig(family), [family])
  const transport = useMemo(() => resolveBusTransportByFamily(family), [family])

  const [status, setStatus] = useState(() => transport.getStatus())
  const [actionError, setActionError] = useState("")

  const transportRef = useRef(transport)
  transportRef.current = transport

  const setFamily = useCallback(
    (next) => {
      const normalized = normalizeBusTransportFamily(next)
      writeJsonStorage(BUS_TRANSPORT_FAMILY_STORAGE_KEY, normalized)
      if (transportFamilyProp == null) {
        setInternalFamily(normalized)
      }
      onTransportFamilyChange?.(normalized)
      const cfg = resolveBusBaudConfig(normalized)
      onBaudRateChange?.(cfg.defaultBaud)
    },
    [transportFamilyProp, onTransportFamilyChange, onBaudRateChange]
  )

  useEffect(() => {
    if (transportFamilyProp != null) {
      setInternalFamily(normalizeBusTransportFamily(transportFamilyProp))
    }
  }, [transportFamilyProp])

  const refresh = useCallback(() => {
    setStatus(transportRef.current.getStatus())
  }, [])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, 400)
    return () => window.clearInterval(id)
  }, [refresh, family])

  const handleOpenPort = async () => {
    setActionError("")
    try {
      writeJsonStorage(BUS_TRANSPORT_FAMILY_STORAGE_KEY, family)
      await transportRef.current.open({
        baudRate: baudCfg.defaultBaud,
        requestPortIfNeeded: true,
      })
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
      refresh()
    }
  }

  const handleClosePort = async () => {
    setActionError("")
    try {
      await transportRef.current.close({ releasePort: false })
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!status.supported) {
    return (
      <div className="serial-compact-bar">
        <p className="serial-compact-hint">当前浏览器不支持 Web Serial，请使用 Chrome 或 Edge。</p>
      </div>
    )
  }

  return (
    <div className="serial-compact-bar">
      <div className="serial-compact-protocol">
        <span className="serial-compact-protocol-label">总线类型</span>
        <div className="serial-compact-segment" role="radiogroup" aria-label="总线类型">
          {BUS_TRANSPORT_FAMILY_OPTIONS.map((opt) => {
            const active = family === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={status.connected}
                className={`serial-compact-segment-btn${
                  active
                    ? opt.id === "rj_sbus"
                      ? " serial-compact-segment-btn--active serial-compact-segment-btn--active-rj"
                      : " serial-compact-segment-btn--active"
                    : ""
                }`}
                onClick={() => setFamily(opt.id)}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        <p className="serial-compact-hint" style={{ color: "#64748b" }}>
          {family === "rj_sbus"
            ? `默认 ${baudCfg.defaultBaud}（与 ST 共总线，开一次口即可混发 RJ/ST 报文）`
            : `默认波特率 ${baudCfg.defaultBaud}`}
        </p>
      </div>

      <div className="serial-compact-actions">
        <button
          type="button"
          className="serial-compact-btn serial-compact-btn--open"
          disabled={status.connected}
          onClick={() => void handleOpenPort()}
        >
          Open Port
        </button>
        <button
          type="button"
          className="serial-compact-btn serial-compact-btn--close"
          disabled={!status.connected}
          onClick={() => void handleClosePort()}
        >
          Close Port
        </button>
      </div>

      {actionError ? <p className="serial-compact-err">{actionError}</p> : null}
    </div>
  )
}
