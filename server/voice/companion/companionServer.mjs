/**
 * FaceDEV Local Xinqi Companion — Node / SEA 入口。
 * 默认 http://127.0.0.1:18740
 */

import { startCompanionApp } from "./companionApp.js"

startCompanionApp().then((result) => {
  if (!result?.ok) {
    setTimeout(() => process.exit(1), 80)
    return
  }
  if (result.alreadyRunning) {
    process.exit(0)
  }
  // 正常监听：保持进程
}).catch((error) => {
  console.error("[companion] fatal", error?.message || error)
  setTimeout(() => process.exit(1), 80)
})
