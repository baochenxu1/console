/**
 * 将 dist-sdk 整理为可 npm pack 的 dist-sdk-package（@facedev/sdk）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const distSdk = path.join(root, "dist-sdk")
const outDir = path.join(root, "dist-sdk-package")

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"))
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

if (!existsSync(distSdk)) {
  console.error("缺少 dist-sdk，请先执行: npm run build:sdk")
  process.exit(1)
}

cpSync(distSdk, outDir, { recursive: true })

const rootPkg = readJson(path.join(root, "package.json"))
const version = rootPkg.version || "0.1.0"

const sdkReadmeSrc = path.join(root, "src", "sdk", "README.md")
const sdkReadmeDest = path.join(outDir, "README.md")
if (existsSync(sdkReadmeSrc)) {
  cpSync(sdkReadmeSrc, sdkReadmeDest)
}

const licenseSrc = path.join(root, "LICENSE")
const licenseDest = path.join(outDir, "LICENSE")
if (existsSync(licenseSrc)) {
  cpSync(licenseSrc, licenseDest)
}

const pkg = {
  name: "@facedev/sdk",
  version,
  description:
    "FaceDEV 0.2.0-beta：面部绑定、FinalServoOutput、PWM/SC 总线适配、Tracking 协议与 React 工作台。",
  type: "module",
  main: "./index.js",
  module: "./index.js",
  exports: {
    ".": "./index.js",
    "./core": "./core.js",
    "./binding": "./binding.js",
    "./expression": "./expression.js",
    "./protocol": "./protocol.js",
    "./output": "./output.js",
    "./servo-adapters": "./servo-adapters.js",
    "./tracking": "./tracking.js",
    "./react": "./react.js",
    "./style.css": "./style.css",
  },
  peerDependencies: {
    react: ">=18",
    "react-dom": ">=18",
  },
  sideEffects: ["*.css", "**/*.css"],
}

writeFileSync(path.join(outDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8")

console.log("dist-sdk-package 已生成:", outDir)
console.log("版本:", version)
