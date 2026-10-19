/**
 * Accessible Voice Console tooltip — Base UI primitive, portal + delay + focus.
 */

import { Children, cloneElement, isValidElement } from "react"
import { Tooltip } from "@base-ui/react/tooltip"

export function VoiceTooltipProvider({ children, delay = 400, closeDelay = 80 }) {
  return (
    <Tooltip.Provider delay={delay} closeDelay={closeDelay} timeout={320}>
      {children}
    </Tooltip.Provider>
  )
}

function isNativeButtonElement(element) {
  return isValidElement(element) && element.type === "button"
}

/**
 * @param {{ content?: React.ReactNode, children: React.ReactNode, side?: string, className?: string }} props
 */
export function VoiceTooltip({ content, children, side = "top", className = "" }) {
  if (!content) return children

  const child = isValidElement(children)
    ? Children.only(children)
    : <span className="voice-tip-target" tabIndex={0}>{children}</span>

  const mergedClass = [child.props?.className, "voice-tip-target", className].filter(Boolean).join(" ")
  const trigger = isValidElement(child)
    ? cloneElement(child, {
        className: mergedClass,
        tabIndex: child.props.tabIndex ?? (isNativeButtonElement(child) || child.type === "select" ? child.props.tabIndex : 0),
      })
    : child

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={trigger}
        closeOnClick
      />
      <Tooltip.Portal>
        <Tooltip.Positioner
          side={side}
          sideOffset={8}
          className="voice-tip-positioner"
        >
          <Tooltip.Popup className="voice-tip-popup">
            {content}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
