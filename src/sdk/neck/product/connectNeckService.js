/**
 * Product-level Connect Neck facade (expression editor).
 * Composes existing Browser SLCAN + Runtime Host — does not reimplement protocol.
 */

/**
 * @param {{
 *   transport: {
 *     getPorts?: Function,
 *     getPort?: Function,
 *     selectPort?: Function,
 *     open?: Function,
 *     close?: Function,
 *     getState?: Function,
 *   },
 *   host: {
 *     resolveStartupProfile?: Function,
 *     loadPersistedActiveProfile?: Function,
 *     getSnapshot?: Function,
 *     notifyTransportReady?: Function,
 *     notifyTransportLost?: Function,
 *     enableMotors?: Function,
 *     disableMotors?: Function,
 *     estop?: Function,
 *     clearEstop?: Function,
 *   },
 * }} deps
 */
export function createConnectNeckService(deps = {}) {
  const getTransport = () => deps.transport
  const getHost = () => deps.host

  return {
    /**
     * Connect Neck = profile + open Web Serial + SLCAN ready.
     * Does NOT Enable Motors.
     */
    async connectNeck() {
      const transport = getTransport()
      const host = getHost()
      if (!transport || typeof transport.open !== "function") {
        return { ok: false, error: { code: "NO_TRANSPORT", message: "transport unavailable" } }
      }
      if (!host) {
        return { ok: false, error: { code: "NO_RUNTIME", message: "runtime host unavailable" } }
      }

      try {
        if (typeof host.resolveStartupProfile === "function") {
          await host.resolveStartupProfile()
        }
      } catch (err) {
        return {
          ok: false,
          error: { code: "PROFILE_LOAD_FAILED", message: err?.message || String(err) },
        }
      }

      const snap = host.getSnapshot?.() || {}
      if (snap.profileReady === false || snap.gates?.profileValid === false) {
        // Allow connect with fallback profile if resolveStartupProfile already fell back
        if (!snap.profile?.loaded && !snap.gates?.profileValid) {
          return {
            ok: false,
            error: { code: "INVALID_PROFILE", message: "active profile not ready" },
          }
        }
      }

      try {
        // Always confirm COM via chooser on Connect (user gesture).
        // Never silent-open a sole authorized port — that caused intermittent popup.
        const st0 = transport.getState?.() || {}
        if (st0.slcanReady || st0.state === "READY") {
          host.notifyTransportReady?.()
          return { ok: true, state: "CONNECTED" }
        }

        let selected = null
        if (typeof transport.selectPort === "function") {
          selected = await transport.selectPort()
        }
        if (selected) {
          await transport.open({ port: selected })
        } else {
          await transport.open({})
        }

        host.notifyTransportReady?.()
        const st = transport.getState?.() || {}
        const ready = Boolean(st.slcanReady || st.state === "READY")
        if (!ready) {
          return {
            ok: false,
            error: {
              code: "CONNECT_FAILED",
              message: st.lastError?.message || "transport not READY",
            },
          }
        }
        return { ok: true, state: "CONNECTED" }
      } catch (err) {
        return {
          ok: false,
          error: {
            code: err?.code || "CONNECT_FAILED",
            message: err?.message || String(err),
          },
        }
      }
    },

    async disconnectNeck() {
      const transport = getTransport()
      const host = getHost()
      try {
        host?.disableMotors?.({ discardUnsaved: true })
      } catch {
        /* best effort */
      }
      try {
        await transport?.close?.()
      } catch {
        /* best effort */
      }
      host?.notifyTransportLost?.()
      return { ok: true }
    },

    async enableNeckMotors() {
      const host = getHost()
      if (!host?.enableMotors) {
        return { ok: false, error: { code: "NO_RUNTIME" } }
      }
      return host.enableMotors()
    },

    disableNeckMotors(opts) {
      const host = getHost()
      return host?.disableMotors?.(opts) ?? { ok: false, error: { code: "NO_RUNTIME" } }
    },

    estop() {
      getHost()?.estop?.()
    },

    clearEstop() {
      return getHost()?.clearEstop?.() ?? { ok: false, error: { code: "NO_RUNTIME" } }
    },
  }
}
