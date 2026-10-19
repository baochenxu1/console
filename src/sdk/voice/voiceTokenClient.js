/**
 * 向 FaceDEV Backend 申请 temporary voice token。
 * 前端永不接触 ASSEMBLYAI_API_KEY。
 */

import { defaultFetch } from "./browserApi.js"

export async function fetchVoiceTemporaryToken({
  provider = "assemblyai",
  fetchImpl = defaultFetch,
  baseUrl = "",
} = {}) {
  const path = `${baseUrl}/api/voice/token?provider=${encodeURIComponent(provider)}`
  let response
  try {
    response = await fetchImpl(path, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
  } catch (error) {
    return {
      ok: false,
      code: "TOKEN_FETCH_FAILED",
      message: "无法连接 FaceDEV Voice Token API。",
      error,
      stack: error?.stack,
    }
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok || !data?.token) {
    return {
      ok: false,
      code: data?.error?.code || "TOKEN_FETCH_FAILED",
      message: data?.error?.message || `Token 请求失败（HTTP ${response.status}）。`,
      status: response.status,
    }
  }

  return {
    ok: true,
    provider: data.provider || provider,
    token: String(data.token),
    expiresIn: Number(data.expiresIn) || 60,
  }
}
