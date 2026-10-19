/**
 * Voice env resolver selftest（无真实 API Key、不访问网络）。
 */
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveVoiceServerConfig, parseEnvFile } from "./loadEnv.js"

const dir = mkdtempSync(path.join(tmpdir(), "facedev-voice-env-"))

try {
  writeFileSync(
    path.join(dir, ".env"),
    "ASSEMBLYAI_API_KEY=test_key_from_dotenv\nDEEPGRAM_API_KEY=dg_key_from_dotenv\nXINQI_BASE_URL=http://127.0.0.1:3212\nXINQI_ROBOT_API_KEY=xinqi_key_from_dotenv\n",
    "utf8",
  )
  writeFileSync(
    path.join(dir, ".env.local"),
    "ASSEMBLYAI_API_KEY=test_key_from_local\nDEEPGRAM_API_KEY=dg_key_from_local\nXINQI_ROBOT_API_KEY=xinqi_key_from_local\n",
    "utf8",
  )

  // Case 1: process env 非空优先
  {
    const config = resolveVoiceServerConfig({
      root: dir,
      processEnv: { ASSEMBLYAI_API_KEY: "test_key_from_process" },
    })
    assert.equal(config.assemblyAIAPIKey, "test_key_from_process")
    assert.equal(config.sources.processHasKey, true)
  }

  // Case 1b: process env 为空字符串时，不挡住文件
  {
    const config = resolveVoiceServerConfig({
      root: dir,
      processEnv: { ASSEMBLYAI_API_KEY: "" },
    })
    assert.equal(config.assemblyAIAPIKey, "test_key_from_local")
  }

  // Case 2: 无 process，读文件（.env.local > .env）
  {
    const config = resolveVoiceServerConfig({
      root: dir,
      processEnv: {},
    })
    assert.equal(config.assemblyAIAPIKey, "test_key_from_local")
    assert.equal(config.hasAssemblyAIAPIKey, true)
  }

  // Case 2b: 仅 .env
  {
    const onlyEnv = mkdtempSync(path.join(tmpdir(), "facedev-voice-env-only-"))
    writeFileSync(path.join(onlyEnv, ".env"), "ASSEMBLYAI_API_KEY=test_key_xxx\n", "utf8")
    const config = resolveVoiceServerConfig({
      root: onlyEnv,
      processEnv: {},
    })
    assert.equal(config.assemblyAIAPIKey, "test_key_xxx")
    rmSync(onlyEnv, { recursive: true, force: true })
  }

  // Case 3: 都没有 → 空
  {
    const empty = mkdtempSync(path.join(tmpdir(), "facedev-voice-env-empty-"))
    const config = resolveVoiceServerConfig({
      root: empty,
      processEnv: {},
    })
    assert.equal(config.assemblyAIAPIKey, "")
    assert.equal(config.hasAssemblyAIAPIKey, false)
    rmSync(empty, { recursive: true, force: true })
  }

  // parse 支持引号与 BOM
  {
    const bomDir = mkdtempSync(path.join(tmpdir(), "facedev-voice-env-bom-"))
    writeFileSync(path.join(bomDir, ".env"), "\uFEFFASSEMBLYAI_API_KEY=\"quoted_test_key\"\n", "utf8")
    const parsed = parseEnvFile(path.join(bomDir, ".env"))
    assert.equal(parsed.ASSEMBLYAI_API_KEY, "quoted_test_key")
    rmSync(bomDir, { recursive: true, force: true })
  }

  // Deepgram: process 优先
  {
    const config = resolveVoiceServerConfig({
      root: dir,
      processEnv: { DEEPGRAM_API_KEY: "dg_key_from_process" },
    })
    assert.equal(config.deepgramAPIKey, "dg_key_from_process")
    assert.equal(config.sources.processHasDeepgramKey, true)
  }

  // Deepgram: 无 process → .env.local
  {
    const config = resolveVoiceServerConfig({
      root: dir,
      processEnv: {},
    })
    assert.equal(config.deepgramAPIKey, "dg_key_from_local")
    assert.equal(config.hasDeepgramAPIKey, true)
  }

  // applyToProcessEnv 不覆盖已有非空值
  {
    const env = { ASSEMBLYAI_API_KEY: "keep_me", DEEPGRAM_API_KEY: "keep_dg" }
    resolveVoiceServerConfig({
      root: dir,
      processEnv: env,
      applyToProcessEnv: true,
    })
    assert.equal(env.ASSEMBLYAI_API_KEY, "keep_me")
    assert.equal(env.DEEPGRAM_API_KEY, "keep_dg")
  }

  // Xinqi: .env.local key + default/base from .env
  {
    const config = resolveVoiceServerConfig({
      root: dir,
      processEnv: {},
    })
    assert.equal(config.xinqiRobotApiKey, "xinqi_key_from_local")
    assert.equal(config.xinqiBaseUrl, "http://127.0.0.1:3212")
    assert.equal(config.hasXinqiRobotApiKey, true)
  }

  console.log("voiceEnv.selftest ok")
} finally {
  rmSync(dir, { recursive: true, force: true })
}
