/**
 * Voice token backend selftest（mock upstream，不访问真实网络）。
 */
import assert from "node:assert/strict"
import { fetchAssemblyAITemporaryToken } from "./fetchAssemblyAIToken.js"
import { fetchDeepgramTemporaryToken } from "./fetchDeepgramToken.js"
import { createVoiceTokenHandler } from "./createVoiceTokenHandler.js"
import { VOICE_TOKEN_ERROR_CODES } from "./errors.js"

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key] = value },
    end(payload) { this.body = payload },
  }
}

// --- AssemblyAI ---
{
  const missing = await fetchAssemblyAITemporaryToken({ apiKey: "" })
  assert.equal(missing.status, 500)
  assert.equal(missing.body.error.code, VOICE_TOKEN_ERROR_CODES.MissingServerApiKey)
}

{
  const ok = await fetchAssemblyAITemporaryToken({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { token: "temp-abc", expires_in_seconds: 60 }
      },
    }),
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.provider, "assemblyai")
  assert.equal(ok.body.token, "temp-abc")
  assert.equal(ok.body.expiresIn, 60)
  assert.ok(!JSON.stringify(ok.body).includes("test-key"))
}

{
  const auth = await fetchAssemblyAITemporaryToken({
    apiKey: "bad-key",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() { return { error: "unauthorized" } },
    }),
  })
  assert.equal(auth.status, 502)
  assert.equal(auth.body.error.code, VOICE_TOKEN_ERROR_CODES.UpstreamAuthFailed)
}

{
  const fail = await fetchAssemblyAITemporaryToken({
    apiKey: "key",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async json() { return {} },
    }),
  })
  assert.equal(fail.body.error.code, VOICE_TOKEN_ERROR_CODES.UpstreamTokenFailed)
}

{
  const unavailable = await fetchAssemblyAITemporaryToken({
    apiKey: "key",
    fetchImpl: async () => { throw new Error("network down") },
  })
  assert.equal(unavailable.body.error.code, VOICE_TOKEN_ERROR_CODES.UpstreamUnavailable)
}

{
  const handler = createVoiceTokenHandler({
    fetchAssemblyAIToken: async () => ({
      status: 200,
      body: { provider: "assemblyai", token: "t1", expiresIn: 60 },
    }),
  })
  const res = mockRes()
  await handler({ method: "GET", url: "/api/voice/token?provider=assemblyai" }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).token, "t1")
}

{
  const handler = createVoiceTokenHandler({
    assemblyAIAPIKey: "injected_test_key",
    fetchAssemblyAIToken: async ({ apiKey }) => {
      assert.equal(apiKey, "injected_test_key")
      return {
        status: 200,
        body: { provider: "assemblyai", token: "t-injected", expiresIn: 60 },
      }
    },
  })
  const res = mockRes()
  await handler({ method: "GET", url: "/api/voice/token?provider=assemblyai" }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).token, "t-injected")
}

// --- Deepgram ---
{
  const missing = await fetchDeepgramTemporaryToken({ apiKey: "" })
  assert.equal(missing.status, 500)
  assert.equal(missing.body.error.code, VOICE_TOKEN_ERROR_CODES.MissingServerApiKey)
}

{
  let capturedBody = null
  const ok = await fetchDeepgramTemporaryToken({
    apiKey: "dg-test-key",
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body)
      assert.equal(init.method, "POST")
      assert.equal(init.headers.Authorization, "Token dg-test-key")
      assert.equal(init.headers["Content-Type"], "application/json")
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: "dg-jwt-abc", expires_in: 30 }
        },
      }
    },
  })
  assert.deepEqual(capturedBody, { ttl_seconds: 30 })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.provider, "deepgram")
  assert.equal(ok.body.token, "dg-jwt-abc")
  assert.equal(ok.body.expiresIn, 30)
  assert.equal(Object.hasOwn(ok.body, "access_token"), false)
  assert.ok(!JSON.stringify(ok.body).includes("dg-test-key"))
}

{
  const auth = await fetchDeepgramTemporaryToken({
    apiKey: "bad",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async json() { return { err: "unauthorized" } },
    }),
  })
  assert.equal(auth.body.error.code, VOICE_TOKEN_ERROR_CODES.UpstreamAuthFailed)
}

{
  const denied = await fetchDeepgramTemporaryToken({
    apiKey: "no-member",
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      async json() { return { err_code: "FORBIDDEN", err_msg: "Insufficient permissions" } },
    }),
  })
  assert.equal(denied.body.error.code, VOICE_TOKEN_ERROR_CODES.UpstreamPermissionDenied)
  assert.ok(!JSON.stringify(denied.body).toLowerCase().includes("token "))
}

{
  const fail = await fetchDeepgramTemporaryToken({
    apiKey: "key",
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async json() { return {} },
    }),
  })
  assert.equal(fail.body.error.code, VOICE_TOKEN_ERROR_CODES.UpstreamTokenFailed)
}

{
  const unavailable = await fetchDeepgramTemporaryToken({
    apiKey: "key",
    fetchImpl: async () => { throw new Error("network down") },
  })
  assert.equal(unavailable.body.error.code, VOICE_TOKEN_ERROR_CODES.UpstreamUnavailable)
}

{
  const handler = createVoiceTokenHandler({
    deepgramAPIKey: "dg-injected",
    fetchDeepgramToken: async ({ apiKey }) => {
      assert.equal(apiKey, "dg-injected")
      return {
        status: 200,
        body: { provider: "deepgram", token: "dg-t1", expiresIn: 30 },
      }
    },
  })
  const res = mockRes()
  await handler({ method: "GET", url: "/api/voice/token?provider=deepgram" }, res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.provider, "deepgram")
  assert.equal(body.token, "dg-t1")
  assert.equal(body.expiresIn, 30)
}

{
  const handler = createVoiceTokenHandler({})
  const res = mockRes()
  await handler({ method: "GET", url: "/api/voice/token?provider=foo" }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error.code, VOICE_TOKEN_ERROR_CODES.UnknownProvider)
}

console.log("voiceToken.selftest ok")
