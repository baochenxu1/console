/**
 * Face Console Production Web 构建元数据（复用 package.json version，不另起版本体系）。
 * 由 vite.faceconsole-web.config.js 在 build 时注入。
 */

function readEnv(key, fallback = "") {
  try {
    const v = import.meta.env?.[key]
    if (v == null || v === "") return fallback
    return String(v)
  } catch {
    return fallback
  }
}

export function getFaceConsoleBuildInfo() {
  const version = readEnv("VITE_FACECONSOLE_VERSION", "0.0.0")
  const gitSha = readEnv("VITE_FACECONSOLE_GIT_SHA", "unknown")
  const buildTime = readEnv("VITE_FACECONSOLE_BUILD_TIME", "")
  const shortSha = gitSha === "unknown" ? "unknown" : gitSha.slice(0, 7)
  return {
    version,
    gitSha,
    shortSha,
    buildTime,
    label: `v${version} · ${shortSha}`,
  }
}

export function logFaceConsoleBuildInfo() {
  const info = getFaceConsoleBuildInfo()
  try {
    // 便于用户截图 / 远程排障确认网页版本
    console.info(
      `[Face Console] ${info.label}` +
        (info.buildTime ? ` · built ${info.buildTime}` : "")
    )
  } catch {
    //
  }
  return info
}
