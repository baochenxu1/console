/**
 * Headless screenshots for Neck UI polish acceptance (puppeteer-core + system Chrome).
 */
import puppeteer from "puppeteer-core"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, "../docs")
mkdirSync(outDir, { recursive: true })

const chrome =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
const base = process.env.NECK_UI_BASE || "http://localhost:5173/?page=expression"

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  defaultViewport: { width: 2048, height: 1155 },
  args: ["--no-sandbox", "--disable-gpu"],
})

async function shot(page, name) {
  const path = join(outDir, name)
  await page.screenshot({ path, fullPage: false })
  console.log("wrote", path)
}

try {
  const page = await browser.newPage()
  await page.goto(base, { waitUntil: "networkidle0", timeout: 60000 })
  await page.waitForSelector(".neck-expression-controls", { timeout: 20000 })
  await shot(page, "neck-ui-polish-A-off.png")

  // Enable Neck if disabled
  const enable = await page.$('button::-p-text(启用 Neck)')
  if (enable) {
    await enable.click()
    await page.waitForSelector('[data-neck-view="control"]', { timeout: 10000 })
  }
  await shot(page, "neck-ui-polish-B-disconnected.png")

  const settingsBtn = await page.$('button::-p-text(设置)')
  if (settingsBtn) {
    await settingsBtn.click()
    await page.waitForSelector('[data-testid="neck-settings-view"]', { timeout: 5000 })
    await shot(page, "neck-ui-polish-C-settings.png")
    const back = await page.$('button::-p-text(返回)')
    if (back) await back.click()
  }

  // Calibration view requires motors — inject presentation-only by forcing view via React is hard.
  // Capture Ready-less calibration UI structure by evaluating local presentation isn't available.
  // Fallback: stay on control after settings for D if calib unavailable.
  await page.waitForSelector('[data-testid="neck-control-view"], [data-testid="neck-settings-view"]', {
    timeout: 5000,
  }).catch(() => {})
  // Return to control for D baseline if still in settings
  if (await page.$('[data-testid="neck-settings-view"]')) {
    const back2 = await page.$('button::-p-text(返回)')
    if (back2) await back2.click()
  }
  await shot(page, "neck-ui-polish-D-control.png")
} finally {
  await browser.close()
}
