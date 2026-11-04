"use strict";

// Content script in the isolated world: passes captures from the page (hook.js)
// to the background script. The page cannot reach the background script itself.

const BRIDGE_CHANNEL = "teams-collector/v1"; // must match hook.js
const MESSAGE_TYPE = "captured-response"; // must match background.js
const LOG_PREFIX = "[teams-collector]";
const runtime = (globalThis.browser ?? globalThis.chrome).runtime;

function isBridgeMessage(event) {
  return event.source === window && event.data?.channel === BRIDGE_CHANNEL;
}

window.addEventListener("message", (event) => {
  if (!isBridgeMessage(event)) return;
  // Page scripts can post to this channel too, so background.js validates the
  // payload and treats it strictly as data.
  runtime
    .sendMessage({ type: MESSAGE_TYPE, payload: event.data.payload })
    .catch((error) =>
      console.debug(`${LOG_PREFIX} bridge could not reach the background script:`, error.message),
    );
});
