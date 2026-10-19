import { useEffect, useMemo, useRef, useState } from "react"
import {
  BUS_TRANSPORT_FAMILY_STORAGE_KEY,
  normalizeBusTransportFamily,
  resolveBusBaudConfig,
  resolveBusTransportByFamily,
} from "../../servoAdapters/busServo/resolveBusTransport.js"
import { readJsonStorage } from "../../../utils/storage.js"
import SerialCompactBar from "./SerialCompactBar.jsx"
import "../../../styles/serial-capsule.css"

/**
 * 紧凑串口胶囊：开一次口；RJ@1M 可与 ST 共总线混发报文。
 */
export default function SerialCapsulePanel({
  transportFamily: transportFamilyProp,
  onTransportFamilyChange,
  baudRate,
  onBaudRateChange,
  transportMode: _transportMode = "bus",
  onTransportModeChange,
  showProtocolSwitch = false,
  className = "",
}) {
  void _transportMode
  void onTransportModeChange
  void showProtocolSwitch

  const [family, setFamily] = useState(() =>
    normalizeBusTransportFamily(
      transportFamilyProp ??
        readJsonStorage(BUS_TRANSPORT_FAMILY_STORAGE_KEY, "feetech")
    )
  )

  useEffect(() => {
    if (transportFamilyProp != null) {
      setFamily(normalizeBusTransportFamily(transportFamilyProp))
    }
  }, [transportFamilyProp])

  const baudCfg = useMemo(() => resolveBusBaudConfig(family), [family])
  const transport = useMemo(() => resolveBusTransportByFamily(family), [family])
  const [open, setOpen] = useState(false)
  const [connected, setConnected] = useState(() => transport.getStatus().connected)
  const rootRef = useRef(/** @type {HTMLDivElement | null} */ (null))

  useEffect(() => {
    const tick = () => setConnected(Boolean(transport.getStatus().connected))
    tick()
    const id = window.setInterval(tick, 400)
    return () => window.clearInterval(id)
  }, [transport])

  useEffect(() => {
    if (!open) {
      return undefined
    }
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const handleFamilyChange = (next) => {
    const normalized = normalizeBusTransportFamily(next)
    setFamily(normalized)
    onTransportFamilyChange?.(normalized)
    onBaudRateChange?.(resolveBusBaudConfig(normalized).defaultBaud)
  }

  return (
    <div className={`serial-capsule-wrap ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className={`serial-capsule${open ? " serial-capsule--open" : ""}${
          connected ? " serial-capsule--connected" : ""
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${baudCfg.label} @ ${baudCfg.defaultBaud}`}
      >
        <span className="serial-capsule-dot" aria-hidden />
        <span className="serial-capsule-label">
          {baudCfg.shortLabel} {connected ? "Connected" : "Offline"}
        </span>
      </button>
      {open ? (
        <div className="serial-capsule-popover" role="dialog" aria-label="串口连接">
          <SerialCompactBar
            transportFamily={family}
            onTransportFamilyChange={handleFamilyChange}
            baudRate={baudRate}
            onBaudRateChange={onBaudRateChange}
          />
        </div>
      ) : null}
    </div>
  )
}
