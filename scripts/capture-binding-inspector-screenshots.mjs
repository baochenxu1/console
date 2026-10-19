/**
 * Capture Face Binding Inspector workflow screenshots at real rail width.
 * Usage: FACECONSOLE_URL=http://localhost:5174/?page=facerig node scripts/capture-binding-inspector-screenshots.mjs
 */
import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, "../docs/screenshots/binding-inspector-workflow")
fs.mkdirSync(outDir, { recursive: true })

const base = process.env.FACECONSOLE_URL || "http://localhost:5174/?page=facerig"

async function shot(page, name) {
  const target = page.locator(".face-rig-panel-rail")
  await target.waitFor({ state: "visible", timeout: 15000 })
  const file = path.join(outDir, name)
  await target.screenshot({ path: file })
  console.log("wrote", file)
}

async function selectLeftUpperLid(page) {
  const stack = page.locator(".face-rig-handle-stack--lid").first()
  await stack.waitFor({ state: "visible", timeout: 10000 })
  await stack.click({ force: true })
  await page.waitForTimeout(250)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 })
  await page.waitForSelector(".face-rig-panel-rail", { timeout: 20000 })
  await page.waitForTimeout(1000)

  // Ensure defaults exist then clear for empty shot
  await page.locator("button", { hasText: "恢复默认映射" }).click()
  await page.waitForTimeout(500)

  const clearBtn = page.locator("button", { hasText: "一键清除全部绑定" })
  page.once("dialog", (d) => d.accept())
  await clearBtn.click()
  await page.waitForTimeout(500)
  await shot(page, "A-empty-channel.png")

  await selectLeftUpperLid(page)
  const title = page.locator(".face-rig-binding-summary-title")
  await page.waitForFunction(
    () => {
      const t = document.querySelector(".face-rig-binding-summary-title")
      return t && !/未选择/.test(t.textContent || "")
    },
    null,
    { timeout: 8000 }
  ).catch(() => {})

  await page.locator(".face-rig-binding-empty-state button", { hasText: "新增绑定" }).click()
  await page.waitForSelector(".face-rig-binding-card.is-setup", { timeout: 10000 })
  await page.locator("button", { hasText: "完成绑定设置" }).first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await shot(page, "B-new-binding-setup.png")

  await page.locator("button", { hasText: "完成绑定设置" }).first().click()
  await page.waitForTimeout(300)
  await page.locator(".face-rig-binding-servo-overview").first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await shot(page, "C-completed-binding.png")

  await page.locator(".face-rig-binding-more summary").first().click()
  await page.waitForTimeout(250)
  await page.locator(".face-rig-binding-more-body").first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await shot(page, "D-more-settings.png")

  await page.locator(".face-rig-binding-channel-bar button", { hasText: "新增绑定" }).click()
  await page.waitForTimeout(400)
  await page.locator(".face-rig-binding-list").scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await shot(page, "E-multi-binding.png")

  await browser.close()
  console.log("done", outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
