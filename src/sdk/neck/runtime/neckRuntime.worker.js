/**
 * Vite Dedicated Worker entry for Browser Neck Runtime (R4).
 * SerialPort / WebSerial stay on main thread — this worker only emits CanFrame via postMessage.
 */

import { createNeckRuntimeWorkerLogic } from "./neckRuntimeWorkerLogic.js"

const logic = createNeckRuntimeWorkerLogic({
  postMessage: (msg) => {
    self.postMessage(msg)
  },
})

self.onmessage = (ev) => {
  const data = ev?.data
  void logic.handleMessage(data)
}
