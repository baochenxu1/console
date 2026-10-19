/**
 * Face Rig 控件旁数值展示：固定小数位，避免浮点串过长。
 * @param {unknown} v
 * @param {number} [decimals=2]
 */
export function formatRigNum(v, decimals = 2) {
  const n = Number(v)
  if (!Number.isFinite(n)) {
    return "—"
  }
  const d = Number.isFinite(decimals) && decimals >= 0 && decimals <= 8 ? Math.floor(decimals) : 2
  return n.toFixed(d)
}

/** 一维 scrub 读数：整数、固定宽度，避免负号导致布局抖动 */
export function formatRigScrubInt(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) {
    return "—"
  }
  return String(Math.round(n))
}

/** 百分比平面上的 (x,y)，如嘴角、眼球雷达读数 */
export function formatRigXY(x, y, decimals = 2) {
  const nx = Number(x)
  const ny = Number(y)
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    return "—"
  }
  const d = Number.isFinite(decimals) && decimals >= 0 && decimals <= 8 ? Math.floor(decimals) : 2
  return `${nx.toFixed(d)} · ${ny.toFixed(d)}`
}
