#!/usr/bin/env node
/**
 * Gaze Diagnostic — offline stability + CURRENT vs SHADOW (iris-only) analysis.
 *
 * Usage:
 *   node scripts/analyze-gaze-diagnostic.mjs --scenario static-center path/to/tracking-diagnostic-ai-review.json[.gz]
 *   node scripts/analyze-gaze-diagnostic.mjs --scenario head-yaw --summary-out summary.json file.json.gz
 *   node scripts/analyze-gaze-diagnostic.mjs --scenario eye-horizontal file.json
 *
 * Scenarios: static-center | head-yaw | head-pitch | head-motion-invariance | eye-horizontal | eye-vertical | long-center
 *
 * When shadow columns exist, prints CURRENT vs SHADOW comparison (no algorithm switch advice).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { gunzipSync } from "node:zlib"
import {
  GAZE_ANALYZE_SCENARIOS,
  analyzeGazeDiagnosticPayload,
  formatGazeAnalysisReport,
} from "../src/sdk/tracking/diagnostics/gazeDiagnosticAnalyzer.js"

function parseArgs(argv) {
  const args = { scenario: "static-center", summaryOut: null, file: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--scenario" && argv[i + 1]) {
      args.scenario = argv[++i]
    } else if (a === "--summary-out" && argv[i + 1]) {
      args.summaryOut = argv[++i]
    } else if (a === "--help" || a === "-h") {
      args.help = true
    } else if (!a.startsWith("-")) {
      args.file = a
    }
  }
  return args
}

function loadPayload(filePath) {
  const abs = resolve(filePath)
  const buf = readFileSync(abs)
  const raw =
    abs.endsWith(".gz") || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)
      ? gunzipSync(buf).toString("utf8")
      : buf.toString("utf8")
  return JSON.parse(raw)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.file) {
    console.log(`Usage:
  node scripts/analyze-gaze-diagnostic.mjs --scenario <name> <ai-review.json[.gz]>
  --summary-out <path>   optional single summary JSON

Scenarios: ${GAZE_ANALYZE_SCENARIOS.join(" | ")}`)
    process.exit(args.help ? 0 : 2)
  }
  if (!GAZE_ANALYZE_SCENARIOS.includes(args.scenario)) {
    console.error(`Unknown scenario: ${args.scenario}`)
    process.exit(2)
  }

  const payload = loadPayload(args.file)
  const report = analyzeGazeDiagnosticPayload(payload, { scenario: args.scenario })
  report.inputFile = args.file
  console.log(formatGazeAnalysisReport(report))
  if (args.summaryOut) {
    writeFileSync(resolve(args.summaryOut), JSON.stringify(report, null, 2), "utf8")
    console.log(`[analyze-gaze-diagnostic] wrote ${args.summaryOut}`)
  }
}

main()
