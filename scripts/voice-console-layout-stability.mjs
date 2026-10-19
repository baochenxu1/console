/**
 * Voice Console layout stability + tooltip acceptance (Playwright).
 * Usage: node scripts/voice-console-layout-stability.mjs
 * Requires: playwright + Chromium (uses TEMP/fc-proto-shot if present),
 *           and `npm run dev` on http://localhost:5173
 */

import { createRequire } from "node:module"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "..")
const outDir = path.join(root, "docs/screenshots/voice-console")
const reportPath = path.join(outDir, "layout-stability-report.json")
const baseUrl = process.env.FACECONSOLE_URL || "http://localhost:5173/?page=audioInput"

async function loadPlaywright() {
  const candidates = [
    path.join(process.env.TEMP || "/tmp", "fc-proto-shot/node_modules/playwright"),
    path.join(root, "node_modules/playwright"),
  ]
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(path.join(candidate, "index.mjs")).href)
      return mod
    } catch {
      try {
        const require = createRequire(path.join(candidate, "package.json"))
        return require("playwright")
      } catch {
        /* continue */
      }
    }
  }
  throw new Error("playwright not found — install in TEMP/fc-proto-shot or project")
}

function approxEqual(a, b, tol = 1) {
  return Math.abs(a - b) <= tol
}

function boxKey(box) {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

async function measureRegions(page) {
  const keys = ["header", "toolbar", "workspace", "inspector", "advanced-runtime", "advanced-device"]
  const out = {}
  for (const key of keys) {
    const loc = page.locator(`[data-voice-region="${key}"]`).first()
    const box = await loc.boundingBox()
    out[key] = box ? boxKey(box) : null
  }
  const action = page.locator('[data-voice-action="primary"]')
  const status = page.locator(".voice-toolbar__status-slot")
  const actionBox = await action.boundingBox()
  const statusBox = await status.boundingBox()
  out.actionButton = actionBox ? boxKey(actionBox) : null
  out.statusSlot = statusBox ? boxKey(statusBox) : null
  return out
}

function assertStableSkeleton(before, after, label, { allowHeight = false } = {}) {
  const issues = []
  for (const key of ["header", "toolbar", "workspace", "inspector"]) {
    const a = before[key]
    const b = after[key]
    if (!a || !b) {
      issues.push(`${label}: missing ${key}`)
      continue
    }
    if (!approxEqual(a.x, b.x) || !approxEqual(a.width, b.width)) {
      issues.push(`${label}: ${key} x/width shifted ${JSON.stringify(a)} → ${JSON.stringify(b)}`)
    }
    if (!allowHeight && (!approxEqual(a.y, b.y, 2) || !approxEqual(a.height, b.height, 2))) {
      issues.push(`${label}: ${key} y/height shifted ${JSON.stringify(a)} → ${JSON.stringify(b)}`)
    }
  }
  if (before.actionButton && after.actionButton) {
    if (!approxEqual(before.actionButton.width, after.actionButton.width)) {
      issues.push(`${label}: action button width changed`)
    }
    if (!approxEqual(before.actionButton.x, after.actionButton.x)) {
      issues.push(`${label}: action button x shifted`)
    }
  }
  if (before.statusSlot && after.statusSlot) {
    if (!approxEqual(before.statusSlot.width, after.statusSlot.width, 2)) {
      issues.push(`${label}: status slot width changed`)
    }
  }
  return issues
}

async function injectFixture(page, { deviceLabel, partial, error } = {}) {
  await page.evaluate(({ deviceLabel: d, partial: p, error: e }) => {
    const sel = document.querySelector(".voice-toolbar__mic select")
    if (sel && d) {
      const opt = sel.options[sel.selectedIndex] || sel.options[0]
      if (opt) opt.textContent = d
      const env = document.querySelector(".voice-env-item--mic")
      if (env) env.textContent = d.length > 28 ? `${d.slice(0, 26)}…` : d
    }
    const partialEl = document.querySelector(".voice-partial p")
    if (partialEl && p != null) {
      partialEl.textContent = p
      partialEl.classList.toggle("is-live", Boolean(p))
      partialEl.classList.toggle("is-placeholder", !p)
    }
    const slot = document.querySelector(".voice-status-slot")
    const text = document.querySelector(".voice-status-slot__text")
    if (slot && e) {
      slot.classList.add("is-visible", "is-error")
      if (text) text.textContent = e
    }
  }, { deviceLabel, partial, error })
}

async function main() {
  await mkdir(outDir, { recursive: true })
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  })
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on("pageerror", (err) => consoleErrors.push(String(err)))
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text())
  })

  const issues = []
  const report = { baseUrl, screenshots: [], boxes: {}, tooltips: {}, issues: [] }

  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60000 })
  await page.waitForSelector("[data-voice-region='toolbar']", { timeout: 20000 })
  await page.waitForTimeout(600)

  const idleBoxes = await measureRegions(page)
  report.boxes.idle = idleBoxes
  await page.screenshot({ path: path.join(outDir, "idle-1920.png"), fullPage: false })
  report.screenshots.push("idle-1920.png")

  // Tooltip hover + focus (idle — cleanest focus path)
  {
    const tipTrigger = page.locator(".voice-info-trigger").first()
    const beforeTipLayout = await measureRegions(page)
    await tipTrigger.hover()
    await page.waitForTimeout(550)
    const tipVisible = await page.locator(".voice-tip-popup").count()
    report.tooltips.hoverOpens = tipVisible > 0
    if (tipVisible === 0) issues.push("tooltip hover did not open")
    const afterTipLayout = await measureRegions(page)
    issues.push(...assertStableSkeleton(beforeTipLayout, afterTipLayout, "tooltip-hover-layout"))

    await page.mouse.move(0, 0)
    await page.waitForTimeout(350)
    await page.locator("body").click({ position: { x: 4, y: 4 } })
    await page.waitForTimeout(200)
    await tipTrigger.focus()
    await page.waitForTimeout(700)
    const tipFocusVisible = await page.locator(".voice-tip-popup").count()
    report.tooltips.focusOpens = tipFocusVisible > 0
    if (tipFocusVisible === 0) issues.push("tooltip focus did not open")
    await page.locator("body").click({ position: { x: 4, y: 4 } })
    await page.waitForTimeout(200)
  }

  // Provider switch (AssemblyAI ↔ Deepgram) while idle
  const providerSelect = page.locator(".voice-toolbar__provider select")
  await providerSelect.selectOption("assemblyai")
  await page.waitForTimeout(200)
  const assemblyBoxes = await measureRegions(page)
  report.boxes.assemblyai = assemblyBoxes
  issues.push(...assertStableSkeleton(idleBoxes, assemblyBoxes, "idle→assemblyai"))

  await providerSelect.selectOption("deepgram")
  await page.waitForTimeout(200)
  const deepgramBoxes = await measureRegions(page)
  report.boxes.deepgram = deepgramBoxes
  issues.push(...assertStableSkeleton(assemblyBoxes, deepgramBoxes, "assemblyai→deepgram"))

  await providerSelect.selectOption("mock")
  await page.waitForTimeout(200)

  // Mock start → running
  await page.locator('[data-voice-action="primary"]').click()
  await page.waitForTimeout(1200)
  const runningBoxes = await measureRegions(page)
  report.boxes.running = runningBoxes
  // Workspace height may change idle→running (allowed content swap), but toolbar/inspector width must hold
  for (const key of ["toolbar", "inspector"]) {
    if (!approxEqual(idleBoxes[key].x, runningBoxes[key].x) || !approxEqual(idleBoxes[key].width, runningBoxes[key].width)) {
      issues.push(`idle→running: ${key} x/width shifted`)
    }
  }
  if (!approxEqual(idleBoxes.toolbar.height, runningBoxes.toolbar.height, 2)) {
    issues.push(`idle→running: toolbar height shifted ${idleBoxes.toolbar.height} → ${runningBoxes.toolbar.height}`)
  }
  await page.screenshot({ path: path.join(outDir, "running-1920.png"), fullPage: false })
  report.screenshots.push("running-1920.png")

  // Connecting screenshot: stop then quick start capture is hard; synthesize connecting label via DOM for visual
  // Long device / partial / error stress (fixture-only, no SDK change)
  await injectFixture(page, {
    deviceLabel: "麦克风 (ReSpeaker Lite) (2886:0019) · 默认通讯优先设备",
    partial: "这是一段很长的中文 partial 文本用于验证固定槽位不会把下方识别记录整体往下推移一二三四五六七八九十",
  })
  await page.waitForTimeout(200)
  const longPartialBoxes = await measureRegions(page)
  report.boxes.longPartial = longPartialBoxes
  if (runningBoxes.workspace && longPartialBoxes.workspace) {
    if (!approxEqual(runningBoxes.workspace.height, longPartialBoxes.workspace.height, 2)) {
      issues.push("long partial: workspace height changed")
    }
  }
  await page.screenshot({ path: path.join(outDir, "long-partial-1920.png"), fullPage: false })
  report.screenshots.push("long-partial-1920.png")
  await page.screenshot({ path: path.join(outDir, "long-device-name-1920.png"), fullPage: false })
  report.screenshots.push("long-device-name-1920.png")

  await injectFixture(page, {
    error: "无法连接当前 Provider，请检查网络连接与临时身份认证状态后重试。",
  })
  await page.waitForTimeout(200)
  const longErrorBoxes = await measureRegions(page)
  report.boxes.longError = longErrorBoxes
  if (!approxEqual(runningBoxes.toolbar.height, longErrorBoxes.toolbar.height, 2)) {
    issues.push("long error: toolbar height changed")
  }
  await page.screenshot({ path: path.join(outDir, "error-1920.png"), fullPage: false })
  report.screenshots.push("error-1920.png")

  // Stop session
  const stopBtn = page.locator('[data-voice-action="primary"]')
  if (await stopBtn.isEnabled()) {
    await stopBtn.click()
    await page.waitForTimeout(800)
  }
  const afterStop = await measureRegions(page)
  report.boxes.afterStop = afterStop
  if (!approxEqual(idleBoxes.toolbar.width, afterStop.toolbar.width) || !approxEqual(idleBoxes.toolbar.x, afterStop.toolbar.x)) {
    issues.push("after stop: toolbar x/width shifted vs idle")
  }

  // connecting visual: navigate fresh and screenshot idle as connecting placeholder by forcing status text
  await page.goto(baseUrl, { waitUntil: "networkidle" })
  await page.waitForTimeout(400)
  await page.evaluate(() => {
    const slot = document.querySelector(".voice-status-slot")
    const text = document.querySelector(".voice-status-slot__text") || (() => {
      const el = document.createElement("span")
      el.className = "voice-status-slot__text"
      slot?.querySelector(".voice-status-slot__inner")?.prepend(el)
      return el
    })()
    slot?.classList.add("is-visible")
    if (text) text.textContent = "正在连接 AssemblyAI"
    const pill = document.querySelector(".voice-live-pill__text")
    if (pill) pill.textContent = "Connecting"
  })
  await page.screenshot({ path: path.join(outDir, "connecting-1920.png"), fullPage: false })
  report.screenshots.push("connecting-1920.png")

  // 1440
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(baseUrl, { waitUntil: "networkidle" })
  await page.waitForTimeout(500)
  await page.locator('[data-voice-action="primary"]').click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: path.join(outDir, "running-1440.png"), fullPage: false })
  report.screenshots.push("running-1440.png")

  report.issues = issues
  report.consoleErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e))
  report.pass = issues.length === 0

  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8")
  await browser.close()

  console.log(JSON.stringify({ pass: report.pass, issues: report.issues, tooltips: report.tooltips, screenshots: report.screenshots }, null, 2))
  if (!report.pass) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
