import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { looksLikeXinqiRoot, resolveXinqiRoot } from "./resolveXinqiRoot.js"
import { loadXinqiRobotKeyFromRoot } from "./loadXinqiRobotKey.js"

const tmp = mkdtempSync(path.join(os.tmpdir(), "facedev-xinqi-root-"))
try {
  assert.equal(looksLikeXinqiRoot(tmp).ok, false)

  mkdirSync(path.join(tmp, "scripts"), { recursive: true })
  writeFileSync(path.join(tmp, "start.cmd"), "@echo off\n", "utf8")
  writeFileSync(path.join(tmp, "scripts", "launch.mjs"), "console.log(1)\n", "utf8")
  writeFileSync(
    path.join(tmp, ".env"),
    'ROBOT_API_KEY="secret-key-with=equals"\nXINQI_BASE_URL=http://127.0.0.1:3210\n',
    "utf8",
  )

  assert.equal(looksLikeXinqiRoot(tmp).ok, true)

  const byArg = resolveXinqiRoot({
    argv: ["node", "x", `--xinqi-root=${tmp}`],
    isSea: false,
  })
  assert.equal(byArg.ok, true)
  assert.equal(byArg.source, "argv")

  const bySea = resolveXinqiRoot({
    argv: ["FaceDEV-Companion.exe"],
    execPath: path.join(tmp, "FaceDEV-Companion.exe"),
    isSea: true,
  })
  assert.equal(bySea.ok, true)
  assert.equal(bySea.source, "exe_dir")

  const key = loadXinqiRobotKeyFromRoot(tmp)
  assert.equal(key.ok, true)
  assert.equal(key.robotApiKey, "secret-key-with=equals")
  assert.equal(key.baseUrl, "http://127.0.0.1:3210")

  const missing = loadXinqiRobotKeyFromRoot(path.join(tmp, "nope"))
  assert.equal(missing.ok, false)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log("resolveXinqiRoot.selftest ok")
