/**
 * Neck Engineering host (SDK). Full NeckBridgePanel + Browser/Legacy diagnostics.
 * Not mounted in the product 5-page nav; not for the expression editor.
 */

import { useEffect, useRef, useState } from "react"
import { getSharedNeckBridgeClient, releaseSharedNeckBridgeClient } from "../neck/neckBridgeClient.js"
import {
  detectWebSerialCapability,
  getDefaultNeckHardwareBackend,
  normalizeNeckHardwareBackend,
  canSwitchNeckHardwareBackend,
  NECK_HARDWARE_BACKEND,
  BACKEND_ACTIVE,
} from "../neck/transport/index.js"
import {
  getSharedBrowserSlcanTransport,
  releaseSharedBrowserSlcanTransport,
  subscribeBrowserSlcanState,
  notifyBrowserSlcanState,
} from "../neck/transport/browserSlcanTransportService.js"
import { createBrowserNeckRuntimeHost } from "../neck/runtime/browserNeckRuntimeHost.js"
import NeckBridgePanel from "./NeckBridgePanel.jsx"
import "../../styles/kinematics-lab.css"

export default function NeckEngineeringPanel() {
  const neckBridgeRef = useRef(null)
  const browserSlcanRef = useRef(null)
  const browserRuntimeRef = useRef(null)
  const [neckBridgeSnap, setNeckBridgeSnap] = useState(null)
  const [browserSerialCapability, setBrowserSerialCapability] = useState(() =>
    detectWebSerialCapability()
  )
  const [browserSlcanState, setBrowserSlcanState] = useState(null)
  const [browserRuntimeSnap, setBrowserRuntimeSnap] = useState(null)
  const [authorizedBrowserPortCount, setAuthorizedBrowserPortCount] = useState(0)
  const [neckHardwareBackend, setNeckHardwareBackend] = useState(() =>
    getDefaultNeckHardwareBackend()
  )
  const [backendSwitchError, setBackendSwitchError] = useState(null)

  useEffect(() => {
    setBrowserSerialCapability(detectWebSerialCapability())
    const transport = getSharedBrowserSlcanTransport()
    browserSlcanRef.current = transport
    const host = createBrowserNeckRuntimeHost({
      getTransport: () => browserSlcanRef.current,
    })
    browserRuntimeRef.current = host
    void host.resolveStartupProfile().catch(() => {})
    const unsubTransport = subscribeBrowserSlcanState((s) => {
      setBrowserSlcanState(s)
      if (s?.state === "READY" || s?.slcanReady) host.notifyTransportReady()
      else if (s?.state === "ERROR" || s?.state === "DISCONNECTED") host.notifyTransportLost()
    })
    const unsubRuntime = host.subscribeSnapshot((snap) => setBrowserRuntimeSnap({ ...snap }))
    void (async () => {
      try {
        const ports = await transport.getPorts?.()
        setAuthorizedBrowserPortCount(Array.isArray(ports) ? ports.length : 0)
      } catch {
        setAuthorizedBrowserPortCount(0)
      }
    })()
    return () => {
      unsubTransport()
      unsubRuntime()
      browserSlcanRef.current = null
      browserRuntimeRef.current = null
      void host.dispose()
      void releaseSharedBrowserSlcanTransport()
    }
  }, [])

  useEffect(() => {
    const client = getSharedNeckBridgeClient()
    neckBridgeRef.current = client
    setNeckBridgeSnap(client.getSnapshot())
    const unsub = client.subscribe((snap) => setNeckBridgeSnap({ ...snap }))
    return () => {
      unsub()
      neckBridgeRef.current = null
      releaseSharedNeckBridgeClient()
    }
  }, [])

  function handleBackendChange(next) {
    const backend = normalizeNeckHardwareBackend(next)
    const current = normalizeNeckHardwareBackend(neckHardwareBackend)
    if (backend === current) return
    const browserSt = browserSlcanRef.current?.getState?.() || {}
    const runtimeSnap = browserRuntimeRef.current?.getSnapshot?.() || {}
    const bridgeSnap = neckBridgeRef.current?.getSnapshot?.() || {}
    const gate = canSwitchNeckHardwareBackend({
      from: current,
      to: backend,
      browserTransportState: browserSt.state || browserSlcanState?.state,
      browserSlcanReady: Boolean(browserSt.slcanReady || browserSlcanState?.slcanReady),
      browserRuntimeEnabled: Boolean(runtimeSnap.enabled),
      browserCalibrating: Boolean(runtimeSnap.calibratingNeutral),
      browserEstop: Boolean(runtimeSnap.estop || runtimeSnap.estopLatched),
      bridgeHardwareConnected: Boolean(bridgeSnap.hardwareConnected),
    })
    if (!gate.ok) {
      setBackendSwitchError({ code: gate.code || BACKEND_ACTIVE, message: gate.message })
      return
    }
    setBackendSwitchError(null)
    setNeckHardwareBackend(backend)
    const bridgeHw = Boolean(bridgeSnap.hardwareConnected)
    const browserReady = browserSt.state === "READY" || Boolean(browserSt.slcanReady)
    browserRuntimeRef.current?.setBackendConflict?.(
      (backend === NECK_HARDWARE_BACKEND.BROWSER_SLCAN && bridgeHw) ||
        (backend === NECK_HARDWARE_BACKEND.LUVIA_BRIDGE && browserReady)
    )
  }

  return (
    <section className="kinematics-lab-neck-engineering" aria-label="Neck Engineering">
      <header className="kinematics-lab-neck-engineering-head">
        <h3>Neck Engineering</h3>
        <p className="kinematics-lab-lead">
          Browser CAN / Legacy Luvia Bridge / Profile / Runtime / Physical Debug（工程调试，非表情编排日常路径）
        </p>
      </header>
      <NeckBridgePanel
        snapshot={neckBridgeSnap}
        hardwarePreview={Boolean(neckBridgeSnap?.hardwarePreview)}
        onHardwarePreviewChange={(on) => neckBridgeRef.current?.setHardwarePreview?.(on)}
        onConnectRuntime={() => void neckBridgeRef.current?.connect?.()}
        onDisconnectRuntime={() => neckBridgeRef.current?.disconnect?.()}
        onConnectHardware={(channel) =>
          void neckBridgeRef.current?.connectHardware?.({ channel, virtual: false })
        }
        onDisconnectHardware={() => void neckBridgeRef.current?.disconnectHardware?.()}
        onRefreshPorts={() => neckBridgeRef.current?.listHardwarePorts?.()}
        onResume={() => neckBridgeRef.current?.resume?.()}
        onEnable={() => neckBridgeRef.current?.enable?.()}
        onDisable={() => neckBridgeRef.current?.disable?.()}
        onEstop={() => neckBridgeRef.current?.estop?.()}
        onHold={() => neckBridgeRef.current?.hold?.()}
        onNeutral={() => neckBridgeRef.current?.neutral?.()}
        browserSerialCapability={browserSerialCapability}
        browserSlcanState={browserSlcanState}
        neckHardwareBackend={neckHardwareBackend}
        onNeckHardwareBackendChange={handleBackendChange}
        backendSwitchError={backendSwitchError}
        authorizedBrowserPortCount={authorizedBrowserPortCount}
        onSelectBrowserCanAdapter={() => {
          void (async () => {
            const t = browserSlcanRef.current
            if (!t) return
            try {
              await t.selectPort()
              const ports = await t.getPorts?.()
              setAuthorizedBrowserPortCount(Array.isArray(ports) ? ports.length : 0)
            } catch {
              /* cancelled */
            }
            notifyBrowserSlcanState()
          })()
        }}
        onOpenBrowserSlcan={() => {
          void (async () => {
            const t = browserSlcanRef.current
            if (!t) return
            try {
              const port = t.getPort?.()
              await t.open(port ? { port } : {})
              browserRuntimeRef.current?.notifyTransportReady?.()
            } catch {
              /* open failure */
            }
            notifyBrowserSlcanState()
          })()
        }}
        onCloseBrowserSlcan={() => {
          void (async () => {
            const t = browserSlcanRef.current
            if (!t) return
            await t.close()
            browserRuntimeRef.current?.notifyTransportLost?.()
            notifyBrowserSlcanState()
          })()
        }}
        onSendBrowserSafeDisable={() => {
          void browserRuntimeRef.current?.sendSafeDisable?.()
        }}
        browserRuntimeSnapshot={browserRuntimeSnap}
        onLoadBrowserProfile={(text) => {
          void browserRuntimeRef.current?.loadProfile?.(text, {
            persist: true,
            source: "IMPORT",
          })
        }}
        onExportBrowserProfile={() => {
          const data = browserRuntimeRef.current?.exportProfile?.()
          if (!data) return
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
          const url = URL.createObjectURL(blob)
          const a = document.createElement("a")
          a.href = url
          a.download = `${data.name || "neck-runtime-profile"}.json`
          a.click()
          URL.revokeObjectURL(url)
        }}
        onEnableBrowserMotors={() => void browserRuntimeRef.current?.enableMotors?.()}
        onDisableBrowserMotors={() =>
          browserRuntimeRef.current?.disableMotors?.({ discardUnsaved: true })
        }
        onBrowserHold={() => browserRuntimeRef.current?.hold?.()}
        onBrowserResume={() => browserRuntimeRef.current?.resume?.()}
        onBrowserEstop={() => browserRuntimeRef.current?.estop?.()}
        onBrowserClearEstop={() => browserRuntimeRef.current?.clearEstop?.()}
        onBrowserHardwarePreviewChange={(on) =>
          browserRuntimeRef.current?.setHardwarePreview?.(on)
        }
        onEnterNeutralCalibration={() =>
          browserRuntimeRef.current?.enterNeutralCalibration?.()
        }
        onExitNeutralCalibration={(opts) =>
          browserRuntimeRef.current?.exitNeutralCalibration?.(opts)
        }
        onNudgeCalibrationOffset={(side, delta) =>
          browserRuntimeRef.current?.nudgeCalibrationOffset?.(side, delta)
        }
        onSetCalibrationOffset={(side, value) =>
          browserRuntimeRef.current?.setCalibrationOffset?.(side, value)
        }
        onResetCalibrationTrim={() => browserRuntimeRef.current?.resetCalibrationTrim?.()}
        onSaveCalibration={() => void browserRuntimeRef.current?.saveCalibration?.()}
        onCancelCalibration={() => browserRuntimeRef.current?.cancelCalibration?.()}
      />
    </section>
  )
}
