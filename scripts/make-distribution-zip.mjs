/**
 * 生成分发压缩包：facedev-sdk-<标签>.zip，内含 tgz、docs、示例、Python 服务、测试/发行/反馈文档。
 *
 * 前置：仓库根目录已存在 npm pack 产物 facedev-sdk-<version>.tgz（可先执行 npm run pack:sdk）。
 *
 * 环境变量：
 *   FACEDEV_DIST_VERSION  发行目录标签，默认 v0.2.0-beta（生成 facedev-sdk-v0.2.0-beta/）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const VERSION_LABEL = process.env.FACEDEV_DIST_VERSION || "v0.2.0-beta"
const FOLDER_NAME = `facedev-sdk-${VERSION_LABEL}`

const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "dist-sdk",
  "dist-sdk-package",
])

function readRootPackageVersion() {
  const p = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  return String(p.version || "0.1.0")
}

function tgzName(npmVersion) {
  return `facedev-sdk-${npmVersion}.tgz`
}

/**
 * @param {string} copyRoot 被拷贝树的根（用于 path.relative）
 */
function makeCopyFilter(copyRoot) {
  return (/** @type {string} */ src) => {
    const rel = path.relative(copyRoot, src)
    if (!rel || rel === ".") {
      return true
    }
    const lower = rel.toLowerCase()
    const segs = rel.split(path.sep)
    for (const s of segs) {
      if (SKIP_SEGMENTS.has(s)) {
        return false
      }
    }
    const bn = path.basename(src)
    if (bn.endsWith(".task")) {
      return false
    }
    if (bn.endsWith(".tgz")) {
      return false
    }
    if (lower.endsWith(".pyc") || lower.endsWith(".pyo") || lower.endsWith(".pyd")) {
      return false
    }
    return true
  }
}

function fillTemplate(text, { VERSION_LABEL: vl, NPM_PKG_VERSION: nv }) {
  return text.replaceAll("{{VERSION_LABEL}}", vl).replaceAll("{{NPM_PKG_VERSION}}", nv)
}

function verifyTree(absRoot, { label }) {
  const violations = new Set()

  function checkRel(rel) {
    const segs = rel.split(path.sep)
    if (segs.includes("node_modules")) {
      violations.add("含 node_modules: " + rel)
    }
    if (segs.includes(".venv") || segs.includes("venv")) {
      violations.add("含 Python 虚拟环境目录: " + rel)
    }
    if (segs.includes("__pycache__")) {
      violations.add("含 __pycache__: " + rel)
    }
    if (segs.includes("dist-sdk-package")) {
      violations.add("含 dist-sdk-package: " + rel)
    }
    if (rel.toLowerCase().endsWith(".task")) {
      violations.add("含 .task 模型: " + rel)
    }
  }

  function walk(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const rel = path.relative(absRoot, full)
      if (rel) {
        checkRel(rel)
      }
      if (e.isDirectory()) {
        walk(full)
      }
    }
  }

  walk(absRoot)

  if (violations.size) {
    console.error(`[${label}] 验收失败：`)
    for (const v of violations) {
      console.error("  -", v)
    }
    process.exit(1)
  }
}

function main() {
  const npmPkgVersion = readRootPackageVersion()
  const tgzFile = tgzName(npmPkgVersion)
  const tgzPath = path.join(ROOT, tgzFile)

  if (!existsSync(tgzPath)) {
    console.error("未找到:", tgzPath)
    console.error("请先执行: npm run pack:sdk")
    process.exit(1)
  }

  const stagingParent = path.join(ROOT, "dist", "release-staging")
  const bundleRoot = path.join(stagingParent, FOLDER_NAME)

  rmSync(stagingParent, { recursive: true, force: true })
  mkdirSync(bundleRoot, { recursive: true })

  // 1. tgz
  cpSync(tgzPath, path.join(bundleRoot, tgzFile))

  // 2. docs
  const docsSrc = path.join(ROOT, "docs")
  const docsDst = path.join(bundleRoot, "docs")
  cpSync(docsSrc, docsDst, { recursive: true, filter: makeCopyFilter(docsSrc) })

  // 3. examples/basic-sdk-host
  const exSrc = path.join(ROOT, "examples", "basic-sdk-host")
  const exDst = path.join(bundleRoot, "examples", "basic-sdk-host")
  cpSync(exSrc, exDst, { recursive: true, filter: makeCopyFilter(exSrc) })

  const exPkgPath = path.join(exDst, "package.json")
  const exPkg = JSON.parse(readFileSync(exPkgPath, "utf8"))
  exPkg.dependencies["@facedev/sdk"] = `file:../../${tgzFile}`
  writeFileSync(exPkgPath, JSON.stringify(exPkg, null, 2) + "\n", "utf8")
  const lockPath = path.join(exDst, "package-lock.json")
  if (existsSync(lockPath)) {
    rmSync(lockPath, { force: true })
  }

  // 4. tools/tracking_service
  const toolsSrc = path.join(ROOT, "tools", "tracking_service")
  const toolsDst = path.join(bundleRoot, "tools", "tracking_service")
  cpSync(toolsSrc, toolsDst, { recursive: true, filter: makeCopyFilter(toolsSrc) })

  // 5. 根说明文档
  const distDir = path.join(ROOT, "distribution")
  const tplVars = { VERSION_LABEL, NPM_PKG_VERSION: npmPkgVersion }

  writeFileSync(
    path.join(bundleRoot, `TEST_GUIDE_${VERSION_LABEL}.md`),
    fillTemplate(readFileSync(path.join(distDir, "TEST_GUIDE.template.md"), "utf8"), tplVars),
    "utf8"
  )
  writeFileSync(
    path.join(bundleRoot, `RELEASE_NOTES_${VERSION_LABEL}.md`),
    fillTemplate(readFileSync(path.join(distDir, "RELEASE_NOTES.template.md"), "utf8"), tplVars),
    "utf8"
  )
  cpSync(path.join(distDir, "FEEDBACK_TEMPLATE.md"), path.join(bundleRoot, "FEEDBACK_TEMPLATE.md"))

  console.log("已组包:", bundleRoot)
  verifyTree(bundleRoot, { label: "解压前目录" })

  const zipOut = path.join(ROOT, "dist", `${FOLDER_NAME}.zip`)
  mkdirSync(path.dirname(zipOut), { recursive: true })
  if (existsSync(zipOut)) {
    rmSync(zipOut, { force: true })
  }

  try {
    execSync(`tar -caf "${zipOut}" -C "${stagingParent}" "${FOLDER_NAME}"`, {
      stdio: "inherit",
      shell: process.platform === "win32",
    })
  } catch {
    console.error("tar 打包失败。Windows 10+ 需自带 tar；或手动将下列目录打成 zip：")
    console.error(bundleRoot)
    process.exit(1)
  }

  console.log("已生成:", zipOut)

  try {
    const listed = execSync(`tar -tf "${zipOut}"`, { encoding: "utf8", shell: process.platform === "win32" })
    const bad = []
    for (const line of listed.split(/\r?\n/)) {
      if (!line.trim()) {
        continue
      }
      const lower = line.toLowerCase()
      if (lower.includes("/node_modules/") || lower.endsWith("/node_modules")) {
        bad.push(line)
      }
      if (lower.includes("/.venv/") || lower.includes("/venv/")) {
        bad.push(line)
      }
      if (lower.includes("dist-sdk-package")) {
        bad.push(line)
      }
      if (lower.includes("__pycache__")) {
        bad.push(line)
      }
      if (lower.endsWith(".task")) {
        bad.push(line)
      }
    }
    if (bad.length) {
      console.error("zip 内容验收失败：")
      bad.forEach((b) => console.error("  -", b))
      process.exit(1)
    }
    console.log("zip 内容验收通过（无 node_modules / .venv / dist-sdk-package / __pycache__ / *.task）。")
  } catch {
    console.warn("（提示）无法执行 tar -tf 做 zip 内验收，已跳过。")
  }

  rmSync(stagingParent, { recursive: true, force: true })
  console.log("已清理临时目录:", stagingParent)
}

main()
