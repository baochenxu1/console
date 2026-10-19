export function readJsonStorage(key, fallbackValue) {
  try {
    const raw = window.localStorage.getItem(key)

    if (!raw) {
      return fallbackValue
    }

    return JSON.parse(raw)
  } catch (error) {
    console.warn(`读取 localStorage 失败：${key}`, error)
    return fallbackValue
  }
}

export function writeJsonStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (error) {
    console.warn(`写入 localStorage 失败：${key}`, error)
    return false
  }
}

export function removeStorage(key) {
  try {
    window.localStorage.removeItem(key)
    return true
  } catch (error) {
    console.warn(`删除 localStorage 失败：${key}`, error)
    return false
  }
}
