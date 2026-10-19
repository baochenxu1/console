/**
 * Browser API wrapper 自测：默认依赖必须是 wrapper，不能是裸 native method。
 */
import assert from "node:assert/strict"
import { defaultFetch, defaultNow, isLikelyUnboundNativeMethod } from "./browserApi.js"
import { fetchVoiceTemporaryToken } from "./voiceTokenClient.js"

assert.equal(typeof defaultNow, "function")
assert.equal(typeof defaultFetch, "function")
assert.ok(Number.isFinite(defaultNow()))

// defaultFetch 必须是普通 JS wrapper，而不是未绑定的 native fetch 引用
assert.equal(isLikelyUnboundNativeMethod(defaultFetch), false)
assert.match(Function.prototype.toString.call(defaultFetch), /globalThis\.fetch/)

{
  const calls = []
  const result = await fetchVoiceTemporaryToken({
    provider: "assemblyai",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return {
        ok: true,
        status: 200,
        async json() {
          return { provider: "assemblyai", token: "t-test", expiresIn: 60 }
        },
      }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.token, "t-test")
  assert.equal(calls.length, 1)
}

{
  const result = await fetchVoiceTemporaryToken({
    fetchImpl: async () => {
      throw new TypeError("Illegal invocation")
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, "TOKEN_FETCH_FAILED")
  assert.equal(result.error?.message, "Illegal invocation")
}

console.log("browserApi.selftest ok")
