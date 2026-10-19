/**
 * 全局开发者调试开关（默认关闭）。
 * 开启：localStorage facedev.showDeveloperDebug=1 或 URL ?debug=1
 */
export function isDeveloperDebugEnabled() {
  if (typeof window === "undefined") {
    return false
  }
  try {
    if (localStorage.getItem("facedev.showDeveloperDebug") === "1") {
      return true
    }
    const q = new URLSearchParams(window.location.search)
    if (q.get("debug") === "1" || q.get("dev") === "1") {
      return true
    }
  } catch {
    return false
  }
  return false
}

export function setDeveloperDebugEnabled(on) {
  if (typeof window === "undefined") {
    return
  }
  try {
    if (on) {
      localStorage.setItem("facedev.showDeveloperDebug", "1")
    } else {
      localStorage.removeItem("facedev.showDeveloperDebug")
    }
  } catch {
    /* ignore */
  }
}
