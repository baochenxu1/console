/**
 * @param {number | null | undefined} ms
 */
export function formatVideoClock(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) {
    return "0:00"
  }
  const totalSec = Math.floor(n / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const sec = String(s).padStart(2, "0")
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${sec}`
  }
  return `${m}:${sec}`
}
