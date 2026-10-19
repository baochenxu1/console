/**
 * 16:9 预览窗口占位（Camera / Video / Motion Track）。
 *
 * @param {object} props
 * @param {"camera" | "video" | "motion"} props.variant
 * @param {string} props.emptyTitle
 * @param {string} props.emptyHint
 * @param {boolean} [props.active]
 * @param {string} [props.activeLabel]
 * @param {React.ReactNode} [props.statusHud]
 * @param {React.ReactNode} [props.children]
 */
export default function PreviewViewportPlaceholder({
  variant,
  emptyTitle,
  emptyHint,
  active = false,
  activeLabel = "Active",
  statusHud = null,
  children,
}) {
  return (
    <div className="tp-viewport-shell">
      <div
        className={`tp-viewport${active ? " tp-viewport--active" : ""} tp-viewport--${variant}`}
        aria-label={`${variant} preview`}
      >
        {statusHud}
        {children}
        {!children && !active ? (
          <div className="tp-viewport-empty">
            <div className="tp-viewport-icon" aria-hidden>
              {variant === "camera" ? (
                <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
                  <rect x="6" y="14" width="36" height="24" rx="3" stroke="currentColor" strokeWidth="2" />
                  <circle cx="24" cy="26" r="7" stroke="currentColor" strokeWidth="2" />
                  <path d="M18 14 L22 10 H26 L30 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : variant === "video" ? (
                <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
                  <rect x="8" y="12" width="32" height="24" rx="2" stroke="currentColor" strokeWidth="2" />
                  <path d="M32 20 L40 16 V32 L32 28 Z" fill="currentColor" opacity="0.35" />
                </svg>
              ) : (
                <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
                  <path
                    d="M8 32 L16 20 L24 28 L32 16 L40 32"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <rect x="6" y="8" width="36" height="32" rx="3" stroke="currentColor" strokeWidth="2" />
                </svg>
              )}
            </div>
            <p className="tp-viewport-empty-title">{emptyTitle}</p>
            <p className="tp-viewport-empty-hint">{emptyHint}</p>
          </div>
        ) : null}
        {active && !children ? (
          <div className="tp-viewport-live">
            <span className="tp-viewport-live-dot" aria-hidden />
            <p className="tp-viewport-live-label">{activeLabel}</p>
            <p className="tp-viewport-empty-hint">Camera feed will render here (Phase 4.1+)</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
