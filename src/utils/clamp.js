export function toInt(value, fallback = 0) {
  const number = Number.parseInt(value, 10)

  if (Number.isNaN(number)) {
    return fallback
  }

  return number
}

export function clampNumber(value, min, max) {
  const number = Number(value)

  if (Number.isNaN(number)) {
    return min
  }

  return Math.max(min, Math.min(max, number))
}

export function padNumber(value, width) {
  return String(value).padStart(width, "0")
}
