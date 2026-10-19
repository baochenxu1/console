/**
 * Companion discovery / URL / preferences selftest（无网络）。
 */

import assert from "node:assert/strict"
import {
  COMPANION_DEFAULT_BASE,
  COMPANION_STATUS,
} from "./companionConstants.js"
import {
  buildXinqiCompanionTransport,
  companionStatusTone,
  discoverLocalCompanion,
} from "./companionDiscovery.js"
import {
  clearCompanionPairingToken,
  hasValidStoredPairing,
  loadCompanionPreferences,
  saveCompanionPairingToken,
  saveCompanionPort,
} from "./companionPreferences.js"
// hasValidStoredPairing / loadCompanionPreferences used after stale-token repair
import { assertLoopbackCompanionUrl, buildCompanionBaseUrl } from "./companionUrl.js"

assert.equal(assertLoopbackCompanionUrl("http://127.0.0.1:18740").ok, true)
assert.equal(assertLoopbackCompanionUrl("http://10.0.0.2:18740").ok, false)
assert.equal(buildCompanionBaseUrl(18740), COMPANION_DEFAULT_BASE)

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null },
    setItem(k, v) { map.set(k, String(v)) },
    removeItem(k) { map.delete(k) },
  }
}

{
  const store = memoryStore()
  const saved = saveCompanionPort(18741, store)
  assert.equal(saved.baseUrl, "http://127.0.0.1:18741")
  const prefs = loadCompanionPreferences(store)
  assert.equal(prefs.port, 18741)
  saveCompanionPairingToken({ token: "tok", expiresAt: Date.now() + 10_000 }, store)
  assert.equal(hasValidStoredPairing(loadCompanionPreferences(store)), true)
  saveCompanionPairingToken({ token: "tok", expiresAt: Date.now() - 10 }, store)
  assert.equal(hasValidStoredPairing(loadCompanionPreferences(store)), false)
  clearCompanionPairingToken(store)
}

{
  const transport = buildXinqiCompanionTransport({
    baseUrl: "http://127.0.0.1:18740",
    prefs: { pairingToken: "abc" },
  })
  assert.equal(transport.ok, true)
  assert.equal(transport.sessionUrl(), "http://127.0.0.1:18740/api/voice/xinqi/session")
  assert.ok(String(transport.realtimeUrl("gw1")).includes("pairing=abc"))
  assert.equal(transport.sessionHeaders.Authorization, "Bearer abc")
}

{
  const offline = await discoverLocalCompanion({
    fetchImpl: async () => { throw new TypeError("Failed to fetch") },
    permissionDeps: {
      permissions: {
        query: async () => ({ state: "granted" }),
      },
    },
    store: memoryStore(),
  })
  assert.equal(offline.status, COMPANION_STATUS.COMPANION_OFFLINE)
}

{
  const denied = await discoverLocalCompanion({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    permissionDeps: {
      permissions: {
        query: async () => ({ state: "denied" }),
      },
    },
    store: memoryStore(),
  })
  assert.equal(denied.status, COMPANION_STATUS.BROWSER_PERMISSION_DENIED)
}

{
  const store = memoryStore()
  const needPair = await discoverLocalCompanion({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        xinqi: { reachable: true },
        pairing: { pairingRequired: true, paired: false },
      }),
    }),
    permissionDeps: {
      permissions: { query: async () => ({ state: "granted" }) },
    },
    store,
  })
  assert.equal(needPair.status, COMPANION_STATUS.PAIRING_REQUIRED)
}

{
  const store = memoryStore()
  saveCompanionPairingToken({ token: "live", expiresAt: Date.now() + 60_000 }, store)
  const complete = await discoverLocalCompanion({
    fetchImpl: async (_url, init) => {
      const auth = init?.headers?.Authorization || ""
      return {
        ok: true,
        json: async () => ({
          ok: true,
          xinqi: { reachable: true },
          pairing: {
            pairingRequired: false,
            paired: true,
            clientAuthorized: auth.includes("live"),
            browserPairingRequired: !auth.includes("live"),
          },
        }),
      }
    },
    permissionDeps: {
      permissions: { query: async () => ({ state: "granted" }) },
    },
    store,
  })
  assert.equal(complete.status, COMPANION_STATUS.PAIRING_COMPLETE)
  assert.equal(companionStatusTone(complete.status), "ok")
}

{
  const store = memoryStore()
  saveCompanionPairingToken({ token: "stale", expiresAt: Date.now() + 60_000 }, store)
  const stale = await discoverLocalCompanion({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        xinqi: { reachable: true },
        pairing: {
          pairingRequired: false,
          paired: true,
          clientAuthorized: false,
          browserPairingRequired: true,
        },
      }),
    }),
    permissionDeps: {
      permissions: { query: async () => ({ state: "granted" }) },
    },
    store,
  })
  assert.equal(stale.status, COMPANION_STATUS.PAIRING_REQUIRED)
  assert.equal(hasValidStoredPairing(loadCompanionPreferences(store)), false)
}

{
  const store = memoryStore()
  saveCompanionPairingToken({ token: "live", expiresAt: Date.now() + 60_000 }, store)
  const xinqiDown = await discoverLocalCompanion({
    fetchImpl: async (_url, init) => {
      const auth = init?.headers?.Authorization || ""
      return {
        ok: true,
        json: async () => ({
          ok: true,
          xinqi: { reachable: false },
          pairing: {
            pairingRequired: false,
            paired: true,
            clientAuthorized: auth.includes("live"),
            browserPairingRequired: !auth.includes("live"),
          },
        }),
      }
    },
    permissionDeps: {
      permissions: { query: async () => ({ state: "granted" }) },
    },
    store,
  })
  assert.equal(xinqiDown.status, COMPANION_STATUS.XINQI_ENGINE_UNAVAILABLE)
}

console.log("companionDiscovery.selftest ok")
