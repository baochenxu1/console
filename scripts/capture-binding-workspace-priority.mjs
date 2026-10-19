/**
 * Capture left-rail workspace priority polish screenshot.
 * FACECONSOLE_URL=http://localhost:5173/?page=facerig node scripts/capture-binding-workspace-priority.mjs
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, "../docs/screenshots/binding-inspector-workflow")
fs.mkdirSync(outDir, { recursive: true })
const base = process.env.FACECONSOLE_URL || "http://localhost:5173/?page=facerig"

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 })
  await page.waitForSelector(".face-rig-workspace-action-full", { timeout: 20000 })
  await page.waitForTimeout(800)
  const rail = page.locator(".face-rig-panel-rail")
  await rail.screenshot({ path: path.join(outDir, "F-workspace-priority-top.png") })
  console.log("wrote F-workspace-priority-top.png")
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
