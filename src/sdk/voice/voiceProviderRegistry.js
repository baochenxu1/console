/**
 * 轻量 Provider 注册表：Mock + AssemblyAI + Deepgram。
 */

import { createMockVoiceProvider } from "./mockVoiceProvider.js"
import { createAssemblyAIProvider } from "./providers/assemblyAIProvider.js"
import { createDeepgramProvider } from "./providers/deepgramProvider.js"
import { createXinqiProvider } from "./providers/xinqiProvider.js"

const builders = {
  mock: createMockVoiceProvider,
  assemblyai: createAssemblyAIProvider,
  deepgram: createDeepgramProvider,
  xinqi: createXinqiProvider,
}

export function listVoiceProviders() {
  return [
    { id: "mock", label: "Mock" },
    { id: "assemblyai", label: "AssemblyAI" },
    { id: "deepgram", label: "Deepgram" },
    { id: "xinqi", label: "Xinqi" },
  ]
}

/**
 * @param {string} [id]
 * @param {object} [options] 透传给具体 Provider（如 Xinqi Companion transport）
 */
export function createVoiceProvider(id = "mock", options = {}) {
  const key = String(id || "mock")
  const builder = builders[key]
  if (!builder) {
    throw new Error(`未知 VoiceProvider：${key}`)
  }
  return builder(options || {})
}
