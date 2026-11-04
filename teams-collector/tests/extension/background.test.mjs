import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const BACKGROUND_SOURCE = readFileSync(
  new URL("../../extension/background.js", import.meta.url),
  "utf8",
);
const SECRET = "a-long-test-secret-value";
const SECRET_KEY = "collectorSecret";
const SETTLE_DELAY_MS = 10;
const PAYLOAD = {
  url: "https://teams.microsoft.com/api/assignments?token=abc",
  body: "{}",
  captured_at: "2026-11-02T10:00:00.000Z",
};

function waitForPendingWork() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
}

function createStorage(initialEntries) {
  const entries = new Map(initialEntries);
  return {
    entries,
    get: async (key) =>
      key === null ? Object.fromEntries(entries) : { [key]: entries.get(key) },
    set: async (items) => Object.entries(items).forEach(([key, value]) => entries.set(key, value)),
    remove: async (key) => entries.delete(key),
  };
}

function queuedKeys(storage) {
  return [...storage.entries.keys()].filter((key) => key.startsWith("queue:"));
}

// `respond` receives the request and returns a status code, or throws a network error.
// The error must come from the sandbox's own realm for `instanceof TypeError` to hold.
function loadBackground({ hasSecret = true, respond }) {
  const storage = createStorage(hasSecret ? [[SECRET_KEY, SECRET]] : []);
  const listeners = {};
  const requests = [];
  const sandbox = {
    browser: {
      runtime: {
        onMessage: { addListener: (listener) => (listeners.message = listener) },
        getManifest: () => ({ version: "test" }),
      },
      alarms: { create() {}, onAlarm: { addListener: (listener) => (listeners.alarm = listener) } },
      storage: { local: storage },
    },
    console: { debug() {}, warn() {}, error() {} },
    URL,
    AbortSignal,
    crypto: globalThis.crypto,
    Date,
  };
  const context = vm.createContext(sandbox);
  const networkError = () => new (vm.runInContext("TypeError", context))("Failed to fetch");
  sandbox.fetch = async (url, init) => {
    requests.push({ url, init });
    const status = respond(networkError);
    return { ok: status >= 200 && status < 300, status };
  };
  vm.runInContext(BACKGROUND_SOURCE, context);
  const send = async (payload = PAYLOAD, type = "captured-response") => {
    listeners.message({ type, payload });
    await waitForPendingWork();
  };
  const flush = async () => {
    listeners.alarm({ name: "flush-queue" });
    await waitForPendingWork();
  };
  return { storage, requests, send, flush };
}

test("delivers a record with the secret header and leaves nothing queued", async () => {
  const { storage, requests, send } = loadBackground({ respond: () => 200 });

  await send();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers["X-Collector-Secret"], SECRET);
  assert.equal(JSON.parse(requests[0].init.body).extension_version, "test");
  assert.deepEqual(queuedKeys(storage), []);
});

test("queues the record when the receiver is unreachable", async () => {
  const { storage, send } = loadBackground({
    respond: (networkError) => {
      throw networkError();
    },
  });

  await send();

  assert.equal(queuedKeys(storage).length, 1);
});

test("queues the record without calling the receiver when no secret is stored", async () => {
  const { storage, requests, send } = loadBackground({ hasSecret: false, respond: () => 200 });

  await send();

  assert.equal(requests.length, 0);
  assert.equal(queuedKeys(storage).length, 1);
});

test("keeps the record queued on 401 and on server errors", async () => {
  for (const status of [401, 500]) {
    const { storage, send } = loadBackground({ respond: () => status });
    await send();
    assert.equal(queuedKeys(storage).length, 1, `status ${status}`);
  }
});

test("drops a record the receiver rejects as malformed", async () => {
  const { storage, send } = loadBackground({ respond: () => 400 });

  await send();

  assert.deepEqual(queuedKeys(storage), []);
});

test("drops payloads that fail validation before any request", async () => {
  const { storage, requests, send } = loadBackground({ respond: () => 200 });

  await send({ ...PAYLOAD, body: 42 });
  await send({ ...PAYLOAD, url: "not a url" });

  assert.equal(requests.length, 0);
  assert.deepEqual(queuedKeys(storage), []);
});

test("ignores messages of other types", async () => {
  const { requests, send } = loadBackground({ respond: () => 200 });

  await send(PAYLOAD, "something-else");

  assert.equal(requests.length, 0);
});

test("flush delivers queued records and empties the queue", async () => {
  let isReceiverUp = false;
  const { storage, send, flush } = loadBackground({
    respond: (networkError) => {
      if (!isReceiverUp) throw networkError();
      return 200;
    },
  });
  await send();
  await send();
  assert.equal(queuedKeys(storage).length, 2);

  await flush();
  assert.equal(queuedKeys(storage).length, 2, "kept while the receiver is down");

  isReceiverUp = true;
  await flush();
  assert.deepEqual(queuedKeys(storage), []);
});
