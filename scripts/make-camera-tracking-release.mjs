/**
 * 生成摄像头追踪发布压缩包：完整前端 + Python 追踪服务 + 一键启动脚本 + QUICKSTART。
 *
 * 环境变量：
 *   CAMERA_TRACKING_RELEASE_VERSION  发行标签，默认 FaceConsole-v0.6.2
 *   CAMERA_TRACKING_INCLUDE_MODEL    设为 1 且本机已有 face_landmarker.task 时打入 zip（约 +4MB）
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs"
import { execSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const VERSION_LABEL = process.env.CAMERA_TRACKING_RELEASE_VERSION || "FaceConsole-v0.6.2"
const FOLDER_NAME = VERSION_LABEL
const INCLUDE_MODEL = process.env.CAMERA_TRACKING_INCLUDE_MODEL === "1"
const LOCAL_MODEL_PATH = path.join(ROOT, "tools/tracking_service/models/face_landmarker.task")

const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "dist-sdk",
  "dist-sdk-package",
  "STServo_Python",
  "examples",
  "distribution",
  ".git",
  "RecordData",
  "test_video",
  "uploads",
  "datasets",
])

const SKIP_ROOT_NAMES = new Set([
  "facedev-sdk-0.1.0.tgz",
  "facedev_tracking_debug_current.zip",
  "vite.sdk.config.js",
])

/**
 * @param {string} copyRoot
 */
function makeCopyFilter(copyRoot, { allowTask = false } = {}) {
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
    if (bn.endsWith(".task") && !allowTask) {
      return false
    }
    if (bn.endsWith(".tgz")) {
      return false
    }
    if (bn.endsWith(".zip") && copyRoot === ROOT) {
      return false
    }
    if (lower.endsWith(".pyc") || lower.endsWith(".pyo") || lower.endsWith(".pyd")) {
      return false
    }
    return true
  }
}

function fillTemplate(text, vars) {
  let out = text
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v)
  }
  return out
}

function verifyTree(absRoot, { label, allowTask = false } = {}) {
  const violations = new Set()

  function checkRel(rel) {
    const segs = rel.split(path.sep)
    if (segs.includes("node_modules")) {
      violations.add("含 node_modules: " + rel)
    }
    if (segs.includes(".venv") || segs.includes("venv")) {
      violations.add("含 Python 虚拟环境: " + rel)
    }
    if (segs.includes("__pycache__")) {
      violations.add("含 __pycache__: " + rel)
    }
    if (segs.includes("STServo_Python")) {
      violations.add("含 STServo_Python: " + rel)
    }
    if (segs.includes("RecordData") || segs.includes("test_video")) {
      violations.add("含本地录制/测试数据: " + rel)
    }
    if (segs.includes("uploads") || segs.includes("datasets")) {
      violations.add("含运行时 uploads/datasets: " + rel)
    }
    if (rel.toLowerCase().endsWith(".task") && !allowTask) {
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

function copyFile(src, dst) {
  mkdirSync(path.dirname(dst), { recursive: true })
  cpSync(src, dst)
}

function copyTree(src, dst) {
  cpSync(src, dst, { recursive: true, filter: makeCopyFilter(src) })
}

function copyRootFiles(bundleRoot) {
  const rootFiles = [
    "index.html",
    "package.json",
    "package-lock.json",
    "vite.config.js",
    "jsconfig.json",
    ".gitignore",
  ]
  for (const name of rootFiles) {
    const src = path.join(ROOT, name)
    if (existsSync(src)) {
      copyFile(src, path.join(bundleRoot, name))
    }
  }
}

function copyScriptsSubset(bundleRoot) {
  const scriptsDst = path.join(bundleRoot, "scripts")
  mkdirSync(scriptsDst, { recursive: true })
  const keep = ["print-project-tree.mjs"]
  for (const name of keep) {
    const src = path.join(ROOT, "scripts", name)
    if (existsSync(src)) {
      copyFile(src, path.join(scriptsDst, name))
    }
  }
}

function copyReleaseScripts(bundleRoot) {
  const releaseSrc = path.join(ROOT, "release")
  const names = [
    "setup-camera-tracking.ps1",
    "start-camera-tracking.ps1",
    "start-camera-tracking.bat",
    "setup-camera-tracking.sh",
    "start-camera-tracking.sh",
    "tracking-model.ps1",
    "tracking-model.sh",
  ]
  for (const name of names) {
    const src = path.join(releaseSrc, name)
    if (!existsSync(src)) {
      console.error("缺少发布脚本:", src)
      process.exit(1)
    }
    const dst = path.join(bundleRoot, name)
    copyFile(src, dst)
    if (name.endsWith(".sh")) {
      try {
        chmodSync(dst, 0o755)
      } catch {
        /* Windows 可忽略 */
      }
    }
  }
}

function writeQuickstart(bundleRoot) {
  const tplPath = path.join(ROOT, "distribution", "QUICKSTART_CAMERA_TRACKING.template.md")
  if (!existsSync(tplPath)) {
    console.error("缺少模板:", tplPath)
    process.exit(1)
  }
  const text = fillTemplate(readFileSync(tplPath, "utf8"), { VERSION_LABEL })
  writeFileSync(path.join(bundleRoot, "QUICKSTART.md"), text, "utf8")
}

function writeOneClickGuide(bundleRoot) {
  const tplPath = path.join(ROOT, "distribution", "ONE_CLICK_START_GUIDE.template.md")
  if (!existsSync(tplPath)) {
    console.error("缺少模板:", tplPath)
    process.exit(1)
  }
  const text = fillTemplate(readFileSync(tplPath, "utf8"), { VERSION_LABEL })
  writeFileSync(path.join(bundleRoot, "ONE_CLICK_START_GUIDE.md"), text, "utf8")
}

function writeReleaseReadme(bundleRoot) {
  const text = `# Face Console — 发布版 (${VERSION_LABEL})

本目录为**发布解压包**：基础面部运动控制 + 基础摄像头面部追踪展示。

**本版范围**：舵机控制、面部 Rig / 表情编排、摄像头追踪预览与实机驱动入口。  
**不包含**：MediaPipe 录制学习、数据集采集管线及其相关交付能力。

**第一次使用请阅读 [ONE_CLICK_START_GUIDE.md](./ONE_CLICK_START_GUIDE.md)**（从解压到首次运行的逐步命令）。

环境与协议背景见 **[QUICKSTART.md](./QUICKSTART.md)**。

## 最快路径

1. 安装 Node.js 18+、Python 3.10/3.11  
2. 下载 \`face_landmarker.task\` 到 \`tools/tracking_service/models/\`  
3. Windows：\`setup-camera-tracking.ps1\` → \`start-camera-tracking.bat\`  
4. macOS/Linux：\`./setup-camera-tracking.sh\` → \`./start-camera-tracking.sh\`

逐步说明见 **ONE_CLICK_START_GUIDE.md**。
`
  writeFileSync(path.join(bundleRoot, "README.md"), text, "utf8")
}

function assertRequiredPaths(bundleRoot) {
  const required = [
    "package.json",
    "index.html",
    "vite.config.js",
    "src/main.jsx",
    "src/App.jsx",
    "src/pages/TrackingPreviewPage.jsx",
    "tools/tracking_service/mediapipe_tracking_server.py",
    "tools/tracking_service/requirements.txt",
    "tools/tracking_service/mediapipe_mapping.default.json",
    "tools/tracking_service/models/README.md",
    "start-camera-tracking.ps1",
    "start-camera-tracking.bat",
    "setup-camera-tracking.ps1",
    "tracking-model.ps1",
    "tracking-model.sh",
    "QUICKSTART.md",
    "ONE_CLICK_START_GUIDE.md",
  ]
  const missing = required.filter((rel) => !existsSync(path.join(bundleRoot, rel)))
  if (missing.length) {
    console.error("发布包缺少必要文件:")
    missing.forEach((m) => console.error("  -", m))
    process.exit(1)
  }
}

function main() {
  const stagingParent = path.join(ROOT, "dist", "camera-tracking-staging")
  const bundleRoot = path.join(stagingParent, FOLDER_NAME)

  rmSync(stagingParent, { recursive: true, force: true })
  mkdirSync(bundleRoot, { recursive: true })

  console.log("版本标签:", VERSION_LABEL)
  console.log("组包目录:", bundleRoot)
  if (INCLUDE_MODEL) {
    console.log("模型策略: 打入 zip (CAMERA_TRACKING_INCLUDE_MODEL=1)")
  } else {
    console.log("模型策略: 不打入 zip，setup/start 自动下载")
  }

  copyRootFiles(bundleRoot)
  copyTree(path.join(ROOT, "src"), path.join(bundleRoot, "src"))
  copyTree(path.join(ROOT, "tools", "tracking_service"), path.join(bundleRoot, "tools", "tracking_service"))
  copyTree(path.join(ROOT, "docs"), path.join(bundleRoot, "docs"))
  copyScriptsSubset(bundleRoot)
  copyReleaseScripts(bundleRoot)

  if (INCLUDE_MODEL) {
    if (!existsSync(LOCAL_MODEL_PATH)) {
      console.error("CAMERA_TRACKING_INCLUDE_MODEL=1 但未找到本地模型:", LOCAL_MODEL_PATH)
      process.exit(1)
    }
    const modelDst = path.join(bundleRoot, "tools/tracking_service/models/face_landmarker.task")
    mkdirSync(path.dirname(modelDst), { recursive: true })
    cpSync(LOCAL_MODEL_PATH, modelDst)
    console.log("已打入模型:", modelDst)
  }

  writeQuickstart(bundleRoot)
  writeOneClickGuide(bundleRoot)
  writeReleaseReadme(bundleRoot)

  assertRequiredPaths(bundleRoot)
  verifyTree(bundleRoot, { label: "解压前目录", allowTask: INCLUDE_MODEL })

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

  const zipStat = statSync(zipOut)
  console.log("已生成:", zipOut)
  console.log("大小:", (zipStat.size / 1024 / 1024).toFixed(2), "MB")

  try {
    const listed = execSync(`tar -tf "${zipOut}"`, { encoding: "utf8", shell: process.platform === "win32" })
    const bad = []
    for (const line of listed.split(/\r?\n/)) {
      if (!line.trim()) continue
      const lower = line.toLowerCase()
      if (lower.includes("/node_modules/") || lower.endsWith("/node_modules")) bad.push(line)
      if (lower.includes("/.venv/") || lower.includes("/venv/")) bad.push(line)
      if (lower.includes("__pycache__")) bad.push(line)
      if (lower.endsWith(".task") && !INCLUDE_MODEL) bad.push(line)
      if (lower.includes("stservo_python")) bad.push(line)
      if (lower.includes("/uploads/") || lower.includes("/datasets/")) bad.push(line)
      if (lower.includes("/recorddata/") || lower.includes("/test_video/")) bad.push(line)
    }
    if (bad.length) {
      console.error("zip 内容验收失败：")
      bad.forEach((b) => console.error("  -", b))
      process.exit(1)
    }
    console.log("zip 内容验收通过。")
  } catch {
    console.warn("（提示）无法执行 tar -tf 做 zip 内验收，已跳过。")
  }

  rmSync(stagingParent, { recursive: true, force: true })
  console.log("已清理临时目录:", stagingParent)
}

main()
