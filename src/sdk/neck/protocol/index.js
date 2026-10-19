/**
 * Browser-native Neck Runtime R2 / R2.1 protocol — barrel exports.
 * Pure: no UI frameworks, no DOM, no sockets, no Web Serial, no navigator, no timers.
 */

export * from "./canFrame.js"
export * from "./codec.js"
export * from "./bmHmdProtocol.js"
export * from "./bmHmdProtocolAdapter.js"
export * from "./bmHmdFeedback.js"
export * from "./motorCommand.js"
export * from "./motorProtocol.js"
export * from "./motorProtocolRegistry.js"
export * from "./fakeMotorProtocol.js"
export * from "./planNeckTransportCommand.js"

// Transport codecs/profiles — re-exported for R2 backward compatibility
export * from "./slcanCodec.js"
export * from "./transportProfile.js"
