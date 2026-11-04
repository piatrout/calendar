"use strict";

// Runs in the page's own JS world (manifest: "world": "MAIN") so it can wrap the
// fetch and XMLHttpRequest that Teams itself uses.
//
// The block keeps our names off the page's global scope: in strict mode function
// declarations inside a block are block-scoped.
{
  // Same value as in bridge.js: the two files live in different JS worlds
  // and cannot share a module.
  const BRIDGE_CHANNEL = "teams-collector/v1";
  const LOG_PREFIX = "[teams-collector]";
  const MAX_BODY_CHARS = 5_000_000;
  const MAX_REQUEST_BODY_CHARS = 20_000;

  // The only part to edit after stage 0. An empty list captures nothing, so chats
  // and other private traffic never leave the page.
  const URL_PATTERNS = [
    // /assignments/i,
  ];

  function isAllowedUrl(url) {
    return URL_PATTERNS.some((pattern) => pattern.test(url));
  }

  function describeUrl(url) {
    // Only the path is logged: query strings can carry tokens.
    try {
      return new URL(url).pathname;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return "(unparseable url)";
    }
  }

  function reportFailure(stage, url, error) {
    console.debug(`${LOG_PREFIX} ${stage} failed for ${describeUrl(url)}:`, error);
  }

  /**
   * Runs `action` (sync or async) so that a failure is logged and never thrown
   * into the page: a collector bug must not break Teams itself.
   */
  function runWithoutBreakingPage(stage, url, action) {
    try {
      Promise.resolve(action()).catch((error) => reportFailure(stage, url, error));
    } catch (error) {
      reportFailure(stage, url, error);
    }
  }

  function truncateRequestBody(requestBody) {
    return typeof requestBody === "string" ? requestBody.slice(0, MAX_REQUEST_BODY_CHARS) : null;
  }

  // Field names are snake_case because they are the wire format shared with the
  // Python receiver.
  function forwardCapture(capture) {
    if (capture.body.length > MAX_BODY_CHARS) {
      const size = capture.body.length;
      console.warn(`${LOG_PREFIX} skipped a body of ${size} chars: ${describeUrl(capture.url)}`);
      return;
    }
    const payload = {
      ...capture,
      captured_at: new Date().toISOString(),
      frame_origin: window.location.origin,
      is_top_frame: window === window.top,
    };
    // "*" is safe here: the message goes to this same window only.
    window.postMessage({ channel: BRIDGE_CHANNEL, payload }, "*");
  }

  // --- fetch ---

  function resolveFetchMethod(input, requestInit) {
    if (requestInit.method) return requestInit.method.toUpperCase();
    return input instanceof Request ? input.method : "GET";
  }

  async function captureFetchResponse(response, fetchArguments) {
    if (!isAllowedUrl(response.url)) return;
    const [input, requestInit = {}] = fetchArguments;
    // clone() runs synchronously, before the page gets a chance to read the body.
    const body = await response.clone().text();
    forwardCapture({
      source: "fetch",
      url: response.url,
      method: resolveFetchMethod(input, requestInit),
      status: response.status,
      content_type: response.headers.get("content-type"),
      request_body: truncateRequestBody(requestInit.body),
      body,
    });
  }

  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(...fetchArguments) {
    const response = await originalFetch.apply(this, fetchArguments);
    runWithoutBreakingPage("fetch capture", response.url, () =>
      captureFetchResponse(response, fetchArguments),
    );
    return response;
  };

  // --- XMLHttpRequest ---

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  // WeakMap: entries disappear together with the request object, so nothing leaks.
  const methodByRequest = new WeakMap();

  function readResponseText(httpRequest) {
    if (httpRequest.responseType === "" || httpRequest.responseType === "text") {
      return httpRequest.responseText;
    }
    if (httpRequest.responseType === "json") return JSON.stringify(httpRequest.response);
    return null; // blobs and buffers are not used for the data we need
  }

  function captureXmlHttpRequest(httpRequest, requestBody) {
    if (!isAllowedUrl(httpRequest.responseURL)) return;
    const body = readResponseText(httpRequest);
    if (body === null) return;
    forwardCapture({
      source: "xhr",
      url: httpRequest.responseURL,
      method: methodByRequest.get(httpRequest) ?? "GET",
      status: httpRequest.status,
      content_type: httpRequest.getResponseHeader("content-type"),
      request_body: truncateRequestBody(requestBody),
      body,
    });
  }

  XMLHttpRequest.prototype.open = function patchedOpen(method, ...remainingArguments) {
    methodByRequest.set(this, String(method).toUpperCase());
    return originalOpen.call(this, method, ...remainingArguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(requestBody) {
    this.addEventListener("load", () =>
      runWithoutBreakingPage("xhr capture", this.responseURL, () =>
        captureXmlHttpRequest(this, requestBody),
      ),
    );
    return originalSend.call(this, requestBody);
  };

  console.debug(`${LOG_PREFIX} hook installed in ${window.location.origin}`);
}
