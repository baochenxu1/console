/** Windows/macOS/Linux 文件名中禁止使用或易出问题的字符 */
const FILENAME_FORBIDDEN = /[\u0000-\u001f\\/: *?"<>|]/g

/**
 * 从表情工程名称生成可用的导出文件名基名：保留中文等 Unicode，移除非法字符与首尾空白，
 * 连续空白转为下划线并限制长度（避免 FAT/解压工具或极少数环境异常）。
 */
export function sanitizeExpressionExportBasename(rawName, fallbackBase = "expression") {
  const maxLen = 96
  let s = String(rawName ?? "").replace(FILENAME_FORBIDDEN, "").trim()
  s = s.replace(/\s+/gu, "_").replace(/_+/g, "_")
  s = s.replace(/^\.+|\.+$/g, "").replace(/^[_]+|[_]+$/g, "")
  if (s === "." || s === "..") {
    s = ""
  }
  s = s.slice(0, maxLen)
  return s || fallbackBase
}

function sanitizeExpressionIdForFallback(expressionId) {
  const maxLen = 48
  return String(expressionId ?? "")
    .replace(FILENAME_FORBIDDEN, "")
    .trim()
    .replace(/\s+/gu, "_")
    .slice(0, maxLen)
    .replace(/^[_]+|[_]+$/g, "")
}

/**
 * 导出单个表情 JSON 的文件名：`{清理后的表情名}_{yyyyMMdd_HHmmss}.json`
 */
export function buildSingleExpressionExportFilename(expressionName, expressionId) {
  const idFb = sanitizeExpressionIdForFallback(expressionId)
  const fb = idFb || "expression"
  const base = sanitizeExpressionExportBasename(expressionName, fb)
  return `${base}_${getDateTimeText()}.json`
}

export function exportJsonFile(filename, data) {
  const jsonText = JSON.stringify(data, null, 2)

  const blob = new Blob([jsonText], {
    type: "application/json;charset=utf-8",
  })

  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")

  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()

  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 下载纯文本文件（如 CSV）。
 * @param {string} filename
 * @param {string} text
 * @param {string} [mimeType]
 */
export function exportTextFile(filename, text, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function getDateTimeText() {
  const now = new Date()

  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, "0")
  const dd = String(now.getDate()).padStart(2, "0")
  const hh = String(now.getHours()).padStart(2, "0")
  const mi = String(now.getMinutes()).padStart(2, "0")
  const ss = String(now.getSeconds()).padStart(2, "0")

  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`
}
