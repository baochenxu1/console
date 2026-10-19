/**
 * Resolve build metadata for Face Console Production Web.
 * Prefer Cloudflare / CI injected SHA, else local git, else "unknown".
 */
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

export function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  return String(pkg.version || "0.0.0")
}

export function resolveGitSha() {
  const fromEnv =
    process.env.CF_PAGES_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.COMMIT_REF ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    ""
  if (fromEnv.trim()) {
    return fromEnv.trim()
  }
  try {
    return execSync("git rev-parse HEAD", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return "unknown"
  }
}

export function resolveBuildTime() {
  return new Date().toISOString()
}
