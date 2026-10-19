/**
 * Persist active NeckRuntimeProfile (browser IndexedDB; injectable for Node tests).
 * Keyspace: DB `facedev-neck-runtime-profile`, store `profiles`, key `active`.
 */

import {
  exportNeckRuntimeProfile,
  importNeckRuntimeProfile,
  normalizeNeckRuntimeProfile,
} from "../core/neckRuntimeProfile.js"

export const NECK_PROFILE_IDB_NAME = "facedev-neck-runtime-profile"
export const NECK_PROFILE_IDB_STORE = "profiles"
export const NECK_PROFILE_ACTIVE_KEY = "active"

/**
 * In-memory Map backend for Node tests.
 */
export function createMemoryNeckProfileStorage() {
  /** @type {Map<string, object>} */
  const map = new Map()
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null
    },
    async set(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      map.delete(key)
    },
  }
}

function openIdb() {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB unavailable")
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NECK_PROFILE_IDB_NAME, 1)
    req.onerror = () => reject(req.error || new Error("IDB open failed"))
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(NECK_PROFILE_IDB_STORE)) {
        db.createObjectStore(NECK_PROFILE_IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
  })
}

function createIdbStorage() {
  return {
    async get(key) {
      const db = await openIdb()
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(NECK_PROFILE_IDB_STORE, "readonly")
          const store = tx.objectStore(NECK_PROFILE_IDB_STORE)
          const req = store.get(key)
          req.onsuccess = () => resolve(req.result ?? null)
          req.onerror = () => reject(req.error)
        })
      } finally {
        db.close()
      }
    },
    async set(key, value) {
      const db = await openIdb()
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(NECK_PROFILE_IDB_STORE, "readwrite")
          const store = tx.objectStore(NECK_PROFILE_IDB_STORE)
          const req = store.put(value, key)
          req.onsuccess = () => resolve()
          req.onerror = () => reject(req.error)
        })
      } finally {
        db.close()
      }
    },
    async delete(key) {
      const db = await openIdb()
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(NECK_PROFILE_IDB_STORE, "readwrite")
          const store = tx.objectStore(NECK_PROFILE_IDB_STORE)
          const req = store.delete(key)
          req.onsuccess = () => resolve()
          req.onerror = () => reject(req.error)
        })
      } finally {
        db.close()
      }
    },
  }
}

function resolveStorage(options = {}) {
  if (options.storage && typeof options.storage.get === "function") {
    return options.storage
  }
  if (typeof indexedDB !== "undefined") {
    return createIdbStorage()
  }
  // Node / test fallback without injection
  return createMemoryNeckProfileStorage()
}

/**
 * @param {object} profile
 * @param {{ storage?: { get: Function, set: Function, delete: Function } }} [options]
 */
export async function saveActiveNeckProfile(profile, options = {}) {
  const normalized = normalizeNeckRuntimeProfile(profile)
  const payload = exportNeckRuntimeProfile(normalized)
  const storage = resolveStorage(options)
  await storage.set(NECK_PROFILE_ACTIVE_KEY, payload)
  return payload
}

/**
 * @param {{ storage?: object }} [options]
 * @returns {Promise<object|null>}
 */
export async function loadActiveNeckProfile(options = {}) {
  const storage = resolveStorage(options)
  const raw = await storage.get(NECK_PROFILE_ACTIVE_KEY)
  if (raw == null) return null
  return importNeckRuntimeProfile(raw)
}

/**
 * @param {{ storage?: object }} [options]
 */
export async function clearActiveNeckProfile(options = {}) {
  const storage = resolveStorage(options)
  await storage.delete(NECK_PROFILE_ACTIVE_KEY)
}
