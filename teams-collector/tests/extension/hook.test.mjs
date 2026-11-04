import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const HOOK_SOURCE = readFileSync(new URL("../../extension/hook.js", import.meta.url), "utf8");
const BRIDGE_CHANNEL = "teams-collector/v1";
const ORIGIN = "https://teams.microsoft.com";
const MATCHING_URL = `${ORIGIN}/api/assignments/list?token=secret`;
const OTHER_URL = `${ORIGIN}/api/chats/list`;
const OVERSIZED_BODY_CHARS = 5_000_001;

// A fresh class per test: the hook patches the prototype, and patches from one
// test must not stack up on another.
function createFakeXmlHttpRequestClass() {
  return class FakeXmlHttpRequest {
    constructor() {
      this.listeners = {};
      this.responseType = "";
    }
    open() {}
    send() {}
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    }
    getResponseHeader() {
      return "application/json";
    }
  };
}

function createResponse(url, bodyText) {
  return {
    url,
    status: 200,
    headers: { get: () => "application/json" },
    clone: () => ({ text: async () => bodyText }),
  };
}

function waitForPendingWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

// `withTestPattern` inserts a pattern into URL_PATTERNS. Replacing the start of the
// declaration keeps the test independent of the example comment inside the list.
function loadHook({ withTestPattern, fetchImplementation }) {
  const source = withTestPattern
    ? HOOK_SOURCE.replace("const URL_PATTERNS = [", "const URL_PATTERNS = [/assignments/i,")
    : HOOK_SOURCE;
  const postedMessages = [];
  const sandbox = {
    console: { debug() {}, warn() {} },
    URL,
    Request: class {},
    XMLHttpRequest: createFakeXmlHttpRequestClass(),
    fetch: fetchImplementation,
    location: { origin: ORIGIN },
    postMessage: (message) => postedMessages.push(message),
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.runInContext(source, vm.createContext(sandbox));
  return { sandbox, postedMessages };
}

test("captures a fetch response whose address matches a pattern", async () => {
  const { sandbox, postedMessages } = loadHook({
    withTestPattern: true,
    fetchImplementation: async () => createResponse(MATCHING_URL, '{"ok":1}'),
  });

  await sandbox.window.fetch(MATCHING_URL, { method: "post", body: "query" });
  await waitForPendingWork();

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].channel, BRIDGE_CHANNEL);
  const { payload } = postedMessages[0];
  assert.equal(payload.url, MATCHING_URL);
  assert.equal(payload.method, "POST");
  assert.equal(payload.request_body, "query");
  assert.equal(payload.body, '{"ok":1}');
  assert.equal(payload.is_top_frame, true);
});

test("ignores responses from addresses that match no pattern", async () => {
  const { sandbox, postedMessages } = loadHook({
    withTestPattern: true,
    fetchImplementation: async () => createResponse(OTHER_URL, "private chat"),
  });

  await sandbox.window.fetch(OTHER_URL);
  await waitForPendingWork();

  assert.deepEqual(postedMessages, []);
});

test("captures nothing while the pattern list is empty", async () => {
  const { sandbox, postedMessages } = loadHook({
    withTestPattern: false,
    fetchImplementation: async () => createResponse(MATCHING_URL, "{}"),
  });

  await sandbox.window.fetch(MATCHING_URL);
  await waitForPendingWork();

  assert.deepEqual(postedMessages, []);
});

test("still returns the response to the page when capturing fails", async () => {
  const brokenResponse = createResponse(MATCHING_URL, "{}");
  brokenResponse.clone = () => {
    throw new Error("clone failed");
  };
  const { sandbox, postedMessages } = loadHook({
    withTestPattern: true,
    fetchImplementation: async () => brokenResponse,
  });

  const response = await sandbox.window.fetch(MATCHING_URL);
  await waitForPendingWork();

  assert.equal(response, brokenResponse);
  assert.deepEqual(postedMessages, []);
});

test("skips bodies above the size limit", async () => {
  const { sandbox, postedMessages } = loadHook({
    withTestPattern: true,
    fetchImplementation: async () =>
      createResponse(MATCHING_URL, "a".repeat(OVERSIZED_BODY_CHARS)),
  });

  await sandbox.window.fetch(MATCHING_URL);
  await waitForPendingWork();

  assert.deepEqual(postedMessages, []);
});

test("captures a matching XMLHttpRequest response", async () => {
  const { sandbox, postedMessages } = loadHook({
    withTestPattern: true,
    fetchImplementation: async () => createResponse(OTHER_URL, ""),
  });
  const httpRequest = new sandbox.XMLHttpRequest();
  Object.assign(httpRequest, { responseURL: MATCHING_URL, responseText: '{"x":2}', status: 200 });

  httpRequest.open("get", MATCHING_URL);
  httpRequest.send();
  httpRequest.listeners.load();
  await waitForPendingWork();

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].payload.source, "xhr");
  assert.equal(postedMessages[0].payload.method, "GET");
  assert.equal(postedMessages[0].payload.body, '{"x":2}');
});
