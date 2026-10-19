export function bytesToHex(bytes) {
  if (!bytes || !bytes.length) {
    return ""
  }
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes)
  return arr.map((b) => Number(b).toString(16).padStart(2, "0")).join(" ")
}
