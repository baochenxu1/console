/**
 * User Expression Preset IndexedDB store (browser; injectable memory for tests).
 * DB: facedev-expression-presets / store: presets
 */

export const EXPRESSION_PRESET_IDB_NAME = "facedev-expression-presets"
export const EXPRESSION_PRESET_IDB_STORE = "presets"
export const EXPRESSION_PRESET_IDB_VERSION = 1

export function createMemoryExpressionPresetStorage() {
  /** @type {Map<string, object>} */
  const map = new Map()
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null
    },
    async set(key, value) {
      map.set(key, structuredClone(value))
    },
    async delete(key) {
      map.delete(key)
    },
    async keys() {
      return [...map.keys()]
    },
    async clear() {
      map.clear()
    },
  }
}

function openIdb() {
  if (typeof indexedDB === "undefined") {
    throw new Error("indexedDB unavailable")
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(EXPRESSION_PRESET_IDB_NAME, EXPRESSION_PRESET_IDB_VERSION)
    req.onerror = () => reject(req.error || new Error("IDB open failed"))
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(EXPRESSION_PRESET_IDB_STORE)) {
        db.createObjectStore(EXPRESSION_PRESET_IDB_STORE)
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
          const tx = db.transaction(EXPRESSION_PRESET_IDB_STORE, "readonly")
          const store = tx.objectStore(EXPRESSION_PRESET_IDB_STORE)
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
          const tx = db.transaction(EXPRESSION_PRESET_IDB_STORE, "readwrite")
          const store = tx.objectStore(EXPRESSION_PRESET_IDB_STORE)
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
          const tx = db.transaction(EXPRESSION_PRESET_IDB_STORE, "readwrite")
          const store = tx.objectStore(EXPRESSION_PRESET_IDB_STORE)
          const req = store.delete(key)
          req.onsuccess = () => resolve()
          req.onerror = () => reject(req.error)
        })
      } finally {
        db.close()
      }
    },
    async keys() {
      const db = await openIdb()
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(EXPRESSION_PRESET_IDB_STORE, "readonly")
          const store = tx.objectStore(EXPRESSION_PRESET_IDB_STORE)
          const req = store.getAllKeys()
          req.onsuccess = () => resolve(req.result || [])
          req.onerror = () => reject(req.error)
        })
      } finally {
        db.close()
      }
    },
    async clear() {
      const db = await openIdb()
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(EXPRESSION_PRESET_IDB_STORE, "readwrite")
          const store = tx.objectStore(EXPRESSION_PRESET_IDB_STORE)
          const req = store.clear()
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
  return createMemoryExpressionPresetStorage()
}

function normalizeStoredPreset(raw) {
  if (!raw || typeof raw !== "object") return null
  if (!raw.id || !raw.animation || !Array.isArray(raw.animation.keyframes)) return null
  return {
    ...raw,
    source: "user",
    closedClip: Boolean(raw.closedClip),
    supportsRepeat: Boolean(raw.closedClip),
    supportsSequence: Boolean(raw.closedClip),
    durationMs: Math.max(1, Math.round(Number(raw.durationMs) || 1)),
    group: raw.group || "其它",
    name: String(raw.name || "未命名表情"),
  }
}

export async function listUserPresets(options = {}) {
  const storage = resolveStorage(options)
  const keys = await storage.keys()
  const out = []
  for (const key of keys) {
    const raw = await storage.get(key)
    const preset = normalizeStoredPreset(raw)
    if (preset) out.push(preset)
  }
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
  return out
}

export async function getUserPreset(id, options = {}) {
  if (!id) return null
  const storage = resolveStorage(options)
  return normalizeStoredPreset(await storage.get(id))
}

export async function saveUserPreset(preset, options = {}) {
  const normalized = normalizeStoredPreset(preset)
  if (!normalized) {
    throw new Error("invalid user preset")
  }
  const storage = resolveStorage(options)
  await storage.set(normalized.id, normalized)
  return normalized
}

export async function deleteUserPreset(id, options = {}) {
  if (!id) return false
  const storage = resolveStorage(options)
  await storage.delete(id)
  return true
}

export async function updateUserPresetMetadata(id, patch = {}, options = {}) {
  const current = await getUserPreset(id, options)
  if (!current) return null
  const next = {
    ...current,
    name:
      patch.name != null
        ? String(patch.name).trim() || current.name
        : current.name,
    group: patch.group != null ? patch.group : current.group,
    description: patch.description != null ? String(patch.description) : current.description,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String) : current.tags,
    updatedAt: new Date().toISOString(),
  }
  return saveUserPreset(next, options)
}

export async function replaceUserPresetAsset(id, draftFields = {}, options = {}) {
  const current = await getUserPreset(id, options)
  if (!current) return null
  if (!draftFields.animation || !Array.isArray(draftFields.animation.keyframes)) {
    throw new Error("invalid replacement animation")
  }
  const next = {
    ...current,
    durationMs: Math.max(1, Math.round(Number(draftFields.durationMs) || 1)),
    scope: draftFields.scope === "character" ? "character" : "face",
    closedClip: Boolean(draftFields.closedClip),
    validationStatus: draftFields.closedClip ? "ok" : "open_clip",
    supportsRepeat: Boolean(draftFields.closedClip),
    supportsSequence: Boolean(draftFields.closedClip),
    keyframeCount: Math.max(0, Math.round(Number(draftFields.keyframeCount) || 0)),
    hasNeck: Boolean(draftFields.hasNeck),
    animation: draftFields.animation,
    updatedAt: new Date().toISOString(),
  }
  return saveUserPreset(next, options)
}
