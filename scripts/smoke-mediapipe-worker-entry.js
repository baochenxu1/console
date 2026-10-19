/**
 * Browser MediaPipe Worker init smoke page entry.
 * Vite builds this as a standalone page; headless Chrome/Edge dumps DOM for SMOKE_OK / SMOKE_FAIL.
 */
import BrowserFaceLandmarkerWorker from "../src/sdk/tracking/browser/browserFaceLandmarkerWorker.js?worker"
import {
  BROWSER_FACE_LANDMARKER_MODEL_URL,
  BROWSER_MEDIAPIPE_WASM_BASE,
} from "../src/sdk/tracking/browser/browserTrackingConfig.js"

function setStatus(text) {
  const el = document.getElementById("result")
  if (el) el.textContent = text
  document.title = text
  if (text.startsWith("SMOKE_OK")) {
    document.body?.setAttribute("data-smoke", "ok")
  } else if (text.startsWith("SMOKE_FAIL")) {
    document.body?.setAttribute("data-smoke", "fail")
  } else {
    document.body?.setAttribute("data-smoke", "pending")
  }
}

function setResult(ok, detail) {
  setStatus(ok ? `SMOKE_OK ${detail || ""}`.trim() : `SMOKE_FAIL:${detail || "unknown"}`)
}

async function run() {
  setStatus("SMOKE_PENDING")
  /** @type {Worker | null} */
  let worker = null
  try {
    worker = new BrowserFaceLandmarkerWorker()
  } catch (error) {
    setResult(false, `WORKER_CREATE:${error?.message || error}`)
    return
  }

  const timeoutMs = 60000
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      setResult(false, "TIMEOUT: worker did not return ready/error within 60s")
      try {
        worker?.terminate()
      } catch {
        //
      }
      resolve()
    }, timeoutMs)

    worker.onmessage = (event) => {
      const msg = event.data || {}
      if (msg.type === "ready") {
        clearTimeout(timer)
        setResult(
          true,
          `READY delegate=${msg.delegate || "?"} route=${msg.tasksVisionRoute || "?"}`
        )
        try {
          worker.postMessage({ type: "dispose" })
        } catch {
          //
        }
        try {
          worker.terminate()
        } catch {
          //
        }
        resolve()
        return
      }
      if (msg.type === "error") {
        clearTimeout(timer)
        const detail = [
          msg.code || "WORKER_INIT_ERROR",
          msg.name || "Error",
          msg.message || "unknown",
          msg.stack ? `\n${msg.stack}` : "",
        ].join(" | ")
        setResult(false, detail)
        try {
          worker.terminate()
        } catch {
          //
        }
        resolve()
      }
    }

    worker.onerror = (err) => {
      clearTimeout(timer)
      setResult(false, `WORKER_ONERROR:${err?.message || err}`)
      try {
        worker.terminate()
      } catch {
        //
      }
      resolve()
    }

    worker.postMessage({
      type: "init",
      wasmBase: BROWSER_MEDIAPIPE_WASM_BASE,
      modelUrl: BROWSER_FACE_LANDMARKER_MODEL_URL,
    })
  })
}

run().catch((error) => {
  setResult(false, error?.message || String(error))
})
