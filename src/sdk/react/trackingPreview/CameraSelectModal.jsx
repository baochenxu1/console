import { useCallback, useEffect, useState } from "react"

function formatCameraOption(cam) {
  const label = cam?.label ?? `Camera ${cam?.cameraIndex ?? "?"}`
  const w = cam?.width ?? "?"
  const h = cam?.height ?? "?"
  const fps = cam?.fps ?? "?"
  return `${label} — ${w}x${h} @ ${fps}fps`
}

/**
 * 选择摄像头设备 — 确认后才 POST /api/tracking/source 初始化。
 */
export default function CameraSelectModal({
  open = false,
  sourceManager,
  onConfirm,
  onCancel,
}) {
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState("")
  const [testResult, setTestResult] = useState(null)

  const st = sourceManager?.trackingSourceState ?? {}
  const cameras = st.cameras ?? []
  const selectedId = st.selectedCameraId ?? st.preferredCameraId ?? cameras[0]?.cameraId ?? null

  useEffect(() => {
    if (!open) return
    setLocalError("")
    setTestResult(null)
    void sourceManager?.loadCameras?.()
  }, [open, sourceManager])

  const refreshCameras = useCallback(async () => {
    setLocalError("")
    setTestResult(null)
    try {
      await sourceManager?.rescanCameras?.()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    }
  }, [sourceManager])

  const handleSelect = (cameraId) => {
    sourceManager?.setSelectedCameraId?.(cameraId)
    setTestResult(null)
    setLocalError("")
  }

  const handleTest = async () => {
    if (!selectedId || busy) return
    setBusy(true)
    setLocalError("")
    setTestResult(null)
    try {
      const result = await sourceManager?.testCamera?.(selectedId)
      setTestResult(result)
      if (!result?.ok) {
        setLocalError("Camera open failed. Device may be busy.")
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSetPreferred = async () => {
    if (!selectedId || busy) return
    setBusy(true)
    setLocalError("")
    try {
      await sourceManager?.setPreferredCamera?.(selectedId)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleConfirm = async () => {
    if (!selectedId || busy) return
    setBusy(true)
    setLocalError("")
    try {
      await onConfirm?.(selectedId)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="tp-camera-modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="tp-camera-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tp-camera-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="tp-camera-modal__header">
          <h2 id="tp-camera-modal-title">选择摄像头</h2>
          <p className="tp-camera-modal__subtitle">确认后将打开所选设备并初始化预览</p>
        </header>

        <label className="tp-camera-device-panel__field">
          <span>Camera Device</span>
          <select
            value={selectedId ?? ""}
            disabled={busy || cameras.length === 0}
            onChange={(e) => handleSelect(e.target.value || null)}
          >
            {cameras.length === 0 ? (
              <option value="">No camera detected</option>
            ) : (
              cameras.map((cam) => (
                <option key={cam.cameraId} value={cam.cameraId}>
                  {formatCameraOption(cam)}
                  {cam.isPreferred ? " ★" : ""}
                </option>
              ))
            )}
          </select>
        </label>

        <div className="tp-camera-device-panel__actions">
          <button type="button" className="tp-camera-device-panel__btn" disabled={busy} onClick={refreshCameras}>
            Refresh
          </button>
          <button
            type="button"
            className="tp-camera-device-panel__btn"
            disabled={busy || !selectedId}
            onClick={handleTest}
          >
            Test
          </button>
          <button
            type="button"
            className="tp-camera-device-panel__btn"
            disabled={busy || !selectedId}
            onClick={handleSetPreferred}
          >
            Set Preferred
          </button>
        </div>

        {cameras.length === 0 ? (
          <div className="tp-camera-device-panel__empty">
            No camera detected.
            <br />
            请检查摄像头权限、连接状态，或是否被其他程序占用。
          </div>
        ) : null}

        {testResult?.ok ? (
          <div className="tp-camera-device-panel__test-ok">
            Test OK — {testResult.width}x{testResult.height} @ {testResult.fps}fps
          </div>
        ) : null}

        {localError ? <div className="tp-camera-device-panel__error">{localError}</div> : null}

        <footer className="tp-camera-modal__footer">
          <button type="button" className="tp-camera-device-panel__btn" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="tp-camera-device-panel__btn tp-camera-device-panel__btn--primary"
            disabled={busy || !selectedId || st.switching}
            onClick={handleConfirm}
          >
            确认并初始化
          </button>
        </footer>
      </div>
    </div>
  )
}
