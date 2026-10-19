function SvgFace({ children, accent = "#06b6d4" }) {
  return (
    <svg viewBox="0 0 72 72" width="72" height="72" aria-hidden="true">
      <rect x="4" y="4" width="64" height="64" rx="16" fill="#f8fafc" stroke="#e2e8f0" />
      <circle cx="36" cy="34" r="22" fill="#fff" stroke={accent} strokeWidth="1.5" />
      {children}
    </svg>
  )
}

export default function ExpressionPresetThumbnail({ kind = "smile" }) {
  if (kind === "laugh") {
    return (
      <SvgFace accent="#22d3ee">
        <circle cx="28" cy="30" r="2.2" fill="#0f172a" />
        <circle cx="44" cy="30" r="2.2" fill="#0f172a" />
        <path d="M24 42c4 8 20 8 24 0" fill="none" stroke="#0891b2" strokeWidth="2.2" strokeLinecap="round" />
      </SvgFace>
    )
  }
  if (kind === "surprise") {
    return (
      <SvgFace accent="#38bdf8">
        <circle cx="28" cy="30" r="3" fill="none" stroke="#0f172a" strokeWidth="1.6" />
        <circle cx="44" cy="30" r="3" fill="none" stroke="#0f172a" strokeWidth="1.6" />
        <ellipse cx="36" cy="46" rx="4" ry="5" fill="none" stroke="#0891b2" strokeWidth="1.8" />
      </SvgFace>
    )
  }
  if (kind === "confused") {
    return (
      <SvgFace accent="#64748b">
        <path d="M22 24h12" stroke="#0f172a" strokeWidth="1.8" />
        <path d="M38 22l12 5" stroke="#0f172a" strokeWidth="1.8" />
        <circle cx="28" cy="32" r="2" fill="#0f172a" />
        <circle cx="44" cy="32" r="2" fill="#0f172a" />
        <path d="M30 46h12" stroke="#0891b2" strokeWidth="1.8" strokeLinecap="round" />
      </SvgFace>
    )
  }
  if (kind === "angry") {
    return (
      <SvgFace accent="#94a3b8">
        <path d="M22 26l12 4" stroke="#0f172a" strokeWidth="1.8" />
        <path d="M50 26l-12 4" stroke="#0f172a" strokeWidth="1.8" />
        <circle cx="28" cy="34" r="2" fill="#0f172a" />
        <circle cx="44" cy="34" r="2" fill="#0f172a" />
        <path d="M26 48c4-5 16-5 20 0" fill="none" stroke="#0891b2" strokeWidth="2" />
      </SvgFace>
    )
  }
  if (kind === "wink") {
    return (
      <SvgFace accent="#06b6d4">
        <circle cx="28" cy="32" r="2.2" fill="#0f172a" />
        <path d="M40 32h10" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
        <path d="M26 44c3 5 12 5 16 0" fill="none" stroke="#0891b2" strokeWidth="2" />
      </SvgFace>
    )
  }
  return (
    <SvgFace>
      <circle cx="28" cy="32" r="2" fill="#0f172a" />
      <circle cx="44" cy="32" r="2" fill="#0f172a" />
      <path d="M26 44c4 6 16 6 20 0" fill="none" stroke="#0891b2" strokeWidth="2" strokeLinecap="round" />
    </SvgFace>
  )
}
