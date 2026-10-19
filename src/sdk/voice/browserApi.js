/**
 * Browser native API 安全包装：禁止保存裸 method reference 后调用。
 */

/** monotonic clock；始终以 performance 为 receiver 调用 now()。 */
export function defaultNow() {
  if (typeof globalThis.performance?.now === "function") {
    return globalThis.performance.now()
  }
  return Date.now()
}

/** fetch wrapper：避免 `const f = globalThis.fetch; f()` → Illegal invocation。 */
export function defaultFetch(...args) {
  return globalThis.fetch(...args)
}

/** 是否像未绑定的 native function（用于测试 / 防御）。 */
export function isLikelyUnboundNativeMethod(fn) {
  if (typeof fn !== "function") return false
  // native 函数 toString 含 [native code]，且无自定义 wrapper 包装层
  const text = Function.prototype.toString.call(fn)
  return text.includes("[native code]")
}
