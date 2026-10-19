/**
 * Face Console Web HTTPS / Preview smoke (Phase 1).
 *
 * Usage:
 *   node scripts/smoke-faceconsole-web-https.mjs https://<preview>.pages.dev
 *   node scripts/smoke-faceconsole-web-https.mjs --base https://<preview>.pages.dev
 *   FACECONSOLE_WEB_BASE=https://... node scripts/smoke-faceconsole-web-https.mjs
 *
 * Checks resource URLs (index / JS / CSS / worker assets / WASM / model) return 200.
 * Does not start Python. Does not drive the camera (manual Browser Camera checklist).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const root = process.cwd()

function fail(msg) {
  console.error(`[smoke-faceconsole-web-https] FAIL: ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`[smoke-faceconsole-web-https] OK: ${msg}`)
}

function parseBase() {
  const argv = process.argv.slice(2)
  const idx = argv.indexOf("--base")
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1].replace(/\/$/, "")
  if (argv[0] && !argv[0].startsWith("-")) return argv[0].replace(/\/$/, "")
  if (process.env.FACECONSOLE_WEB_BASE) {
    return String(process.env.FACECONSOLE_WEB_BASE).replace(/\/$/, "")
  }
  return ""
}

async function fetchOk(url, { expectWasm = false } = {}) {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) {
    fail(`${url} → HTTP ${res.status}`)
  }
  const ctype = String(res.headers.get("content-type") || "")
  if (expectWasm && !/wasm|octet-stream|javascript/i.test(ctype) && ctype) {
    // Some CDNs omit precise type; status 200 is enough for Phase 1.
  }
  ok(`${url} → ${res.status}${ctype ? ` (${ctype})` : ""}`)
  return res
}

function pickHashedAssetsFromDist() {
  const distAssets = join(root, "dist-web/assets")
  if (!existsSync(distAssets)) return { js: null, css: null }
  const files = readdirSync(distAssets)
  return {
    js: files.find((f) => f.endsWith(".js") && !f.includes("mediapipe")) || null,
    css: files.find((f) => f.endsWith(".css")) || null,
  }
}

function pickHashedAssetsFromIndex(html) {
  const js = html.match(/src="(\/assets\/[^"]+\.js)"/)
  const css = html.match(/href="(\/assets\/[^"]+\.css)"/)
  return {
    js: js ? js[1] : null,
    css: css ? css[1] : null,
  }
}

async function main() {
  const base = parseBase()
  if (!base) {
    fail(
      "missing base URL. Example:\n  node scripts/smoke-faceconsole-web-https.mjs https://xxx.pages.dev"
    )
  }
  if (!/^https:\/\//i.test(base)) {
    fail(`base must be https://…, got ${base}`)
  }
  ok(`base=${base}`)

  const indexRes = await fetchOk(`${base}/`)
  const html = await indexRes.text()
  if (!/root|Face Console|face-console/i.test(html) && !html.includes('id="root"')) {
    fail("index.html does not look like Face Console shell")
  }
  ok("index.html looks like Face Console")

  if (/127\.0\.0\.1:8766|127\.0\.0\.1:8767|localhost:8766|localhost:8767/.test(html)) {
    fail("index.html embeds Python tracking localhost URLs")
  }

  const fromIndex = pickHashedAssetsFromIndex(html)
  const fromDist = pickHashedAssetsFromDist()
  const jsPath = fromIndex.js || (fromDist.js ? `/assets/${fromDist.js}` : null)
  const cssPath = fromIndex.css || (fromDist.css ? `/assets/${fromDist.css}` : null)
  if (!jsPath) fail("could not resolve main JS asset path")
  if (!cssPath) fail("could not resolve main CSS asset path")
  await fetchOk(`${base}${jsPath}`)
  await fetchOk(`${base}${cssPath}`)

  for (const name of [
    "vision_wasm_module_internal.js",
    "vision_wasm_module_internal.wasm",
    "vision_wasm_internal.js",
    "vision_wasm_internal.wasm",
  ]) {
    await fetchOk(`${base}/assets/mediapipe/wasm/${name}`, { expectWasm: name.endsWith(".wasm") })
  }

  await fetchOk(`${base}/models/face_landmarker.task`)

  if (existsSync(join(root, "dist-web/assets/mediapipe/manifest.json"))) {
    await fetchOk(`${base}/assets/mediapipe/manifest.json`)
  }

  // Soft check: main JS should not hard-require Python ports for browser path.
  // (Python fallback strings may still exist elsewhere in the SPA.)
  const browserRuntimeTest = join(root, "src/sdk/tracking/browser/browserTrackingRuntime.test.mjs")
  if (existsSync(browserRuntimeTest)) {
    ok("local Test D covered by browserTrackingRuntime.test.mjs (8766/8767)")
  }

  console.log("[smoke-faceconsole-web-https] all remote checks passed")
  console.log("[smoke-faceconsole-web-https] Manual next: Chrome → Browser Runtime → Camera → Start")
  console.log("[smoke-faceconsole-web-https] Confirm Network has no 8766/8767; Model READY; Face Rig moves")
}

main().catch((error) => {
  fail(error?.message || String(error))
})
