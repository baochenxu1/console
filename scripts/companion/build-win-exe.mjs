/**
 * 构建 Windows 单文件 FaceDEV-Companion.exe（Node SEA）+ 复制联合启动脚本。
 *
 * 产出：
 *   dist/face-dev-xinqi-companion-win/FaceDEV-Companion.exe
 *   dist/face-dev-xinqi-companion-win/start-with-facedev.cmd
 */

import { execFileSync, execSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { createHash as cryptoHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../..")
const outDir = path.join(root, "dist", "face-dev-xinqi-companion-win")
const workDir = path.join(root, "build", "companion-sea")
const entry = path.join(root, "server", "voice", "companion", "companionServer.mjs")
const bundlePath = path.join(workDir, "companion-bundle.cjs")
const seaConfigPath = path.join(workDir, "sea-config.json")
const blobPath = path.join(workDir, "sea-prep.blob")
const exeName = "FaceDEV-Companion.exe"
const exeOut = path.join(outDir, exeName)
const cmdSrc = path.join(__dirname, "start-with-facedev.cmd")
const cmdOut = path.join(outDir, "start-with-facedev.cmd")

function sha256File(filePath) {
  const h = cryptoHash("sha256")
  h.update(readFileSync(filePath))
  return h.digest("hex")
}

function whichEsbuild() {
  try {
    const require = createRequire(import.meta.url)
    return require.resolve("esbuild/bin/esbuild")
  } catch {
    return null
  }
}

mkdirSync(workDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

console.log("[build] root =", root)
console.log("[build] bundling companion entry…")

const esbuildBin = whichEsbuild()
if (esbuildBin) {
  execFileSync(process.execPath, [
    esbuildBin,
    entry,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node20",
    `--outfile=${bundlePath}`,
    "--packages=bundle",
    "--external:node:sea",
  ], { stdio: "inherit", cwd: root })
} else {
  console.log("[build] esbuild not installed locally; using npx esbuild")
  execSync(
    `npx --yes esbuild "${entry}" --bundle --platform=node --format=cjs --target=node20 --outfile="${bundlePath}" --packages=bundle --external:node:sea`,
    { stdio: "inherit", cwd: root, shell: true },
  )
}

if (!existsSync(bundlePath)) {
  console.error("[build] BLOCKED: bundle not created")
  process.exit(1)
}

// SEA 入口包装：保证顶层 await 结果在 CJS 中可运行
const wrapped = `"use strict";\n` + readFileSync(bundlePath, "utf8")
writeFileSync(bundlePath, wrapped, "utf8")

writeFileSync(seaConfigPath, JSON.stringify({
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}, null, 2), "utf8")

console.log("[build] generating SEA blob…")
execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
  stdio: "inherit",
  cwd: root,
})

if (!existsSync(blobPath)) {
  console.error("[build] BLOCKED: sea-prep.blob missing")
  process.exit(1)
}

console.log("[build] copying node.exe →", exeOut)
copyFileSync(process.execPath, exeOut)

// 尽量去掉签名（失败可忽略）
try {
  execSync(`signtool remove /s "${exeOut}"`, { stdio: "ignore", shell: true })
} catch {
  /* optional */
}

console.log("[build] injecting blob with postject…")
execSync(
  `npx --yes postject "${exeOut}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { stdio: "inherit", cwd: root, shell: true },
)

copyFileSync(cmdSrc, cmdOut)

const exeStat = readFileSync(exeOut)
const exeHash = sha256File(exeOut)
const cmdHash = sha256File(cmdOut)

const summary = {
  outDir,
  files: {
    exe: {
      path: exeOut,
      bytes: exeStat.length,
      sha256: exeHash,
    },
    cmd: {
      path: cmdOut,
      bytes: readFileSync(cmdOut).length,
      sha256: cmdHash,
    },
  },
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  buildTime: new Date().toISOString(),
}

writeFileSync(path.join(workDir, "BUILD_INFO.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")

console.log("[build] OK")
console.log(`[build] EXE  ${exeOut}`)
console.log(`[build] size ${exeStat.length} bytes`)
console.log(`[build] sha256 ${exeHash}`)
console.log(`[build] CMD  ${cmdOut}`)
console.log(`[build] info ${path.join(workDir, "BUILD_INFO.json")}`)
console.log("[build] 交付目录仅含两个用户文件：FaceDEV-Companion.exe + start-with-facedev.cmd")
