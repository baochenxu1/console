/**
 * 打印排除依赖、构建产物、本地模型 *.task 等后的项目树（FaceDEV 架构阅读用）。
 * 用法：
 *   node scripts/print-project-tree.mjs
 *   node scripts/print-project-tree.mjs --out docs/PROJECT_TREE.md
 */
import { readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

/** 逻辑根显示名（与物理文件夹名无关） */
const TREE_ROOT_LABEL = "FaceDEV"

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "dist-sdk",
  "dist-sdk-package",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".vite",
])

function skipFile(name) {
  if (name.endsWith(".tgz")) {
    return true
  }
  if (name.endsWith(".task")) {
    return true
  }
  if (name.endsWith(".pyc") || name.endsWith(".pyo") || name.endsWith(".pyd")) {
    return true
  }
  return false
}

function listSorted(fullPath) {
  return readdirSync(fullPath)
    .filter((n) => !SKIP_DIR_NAMES.has(n) && !skipFile(n))
    .sort((a, b) => {
      const sa = statSync(path.join(fullPath, a)).isDirectory() ? 0 : 1
      const sb = statSync(path.join(fullPath, b)).isDirectory() ? 0 : 1
      if (sa !== sb) {
        return sa - sb
      }
      return a.localeCompare(b, "en")
    })
}

/**
 * @param {string} dir
 * @param {string} prefix
 * @param {string[]} lines
 */
function walk(dir, prefix, lines) {
  let entries
  try {
    entries = listSorted(dir)
  } catch {
    return
  }

  entries.forEach((name, index) => {
    if (skipFile(name)) {
      return
    }
    const full = path.join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      return
    }
    const isLast = index === entries.length - 1
    const connector = isLast ? "└── " : "├── "
    const childPrefix = isLast ? "    " : "│   "

    lines.push(`${prefix}${connector}${name}${st.isDirectory() ? "/" : ""}`)

    if (st.isDirectory()) {
      walk(full, prefix + childPrefix, lines)
    }
  })
}

function buildTreeLines() {
  const lines = [`${TREE_ROOT_LABEL}/`]
  walk(ROOT, "", lines)
  return lines
}

function parseArgs(argv) {
  const outIdx = argv.indexOf("--out")
  if (outIdx >= 0 && argv[outIdx + 1]) {
    return { outFile: path.resolve(ROOT, argv[outIdx + 1]) }
  }
  return { outFile: null }
}

const { outFile } = parseArgs(process.argv.slice(2))
const text = buildTreeLines().join("\n") + "\n"

if (outFile) {
  writeFileSync(
    outFile,
    `# 项目树（自动生成）\n\n排除 \`node_modules\`、各类 \`dist\`、\`.venv\`、\`__pycache__\`、\`.vite\`、\`*.tgz\`、本地模型 \`*.task\` 等后的目录结构。\n\n\`\`\`text\n${text}\`\`\`\n`,
    "utf8"
  )
  console.log("已写入:", outFile)
} else {
  process.stdout.write(text)
}
