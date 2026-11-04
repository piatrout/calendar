"use strict";

// Receives captures from content scripts and delivers them to the local receiver.
// While the receiver is not running, records wait in extension storage.

const api = globalThis.browser ?? globalThis.chrome;

const RECEIVER_URL = "http://127.0.0.1:8765/ingest"; // keep in sync with src/capture_receiver.py
const SECRET_HEADER = "X-Collector-Secret";
// The secret lives in extension storage because an extension has no environment
// variables; it is set once by hand (see README).
const SECRET_STORAGE_KEY = "collectorSecret";
const MESSAGE_TYPE = "captured-response"; // must match bridge.js
const QUEUE_KEY_PREFIX = "queue:";
const FLUSH_ALARM_NAME = "flush-queue";
const FLUSH_PERIOD_MINUTES = 1;
const SEND_TIMEOUT_MS = 10_000;
const REQUIRED_TEXT_FIELDS = ["url", "body", "captured_at"];
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR_MIN = 500;
const LOG_PREFIX = "[teams-collector]";

/** Delivery failed for a reason that may go away: keep the record and try later. */
class RetryLaterError extends Error {}

/** Same, but the user has to act: the secret was never stored. */
class MissingSecretError extends RetryLaterError {}

/** The receiver refused the record itself: retrying cannot help. */
class RecordRejectedError extends Error {}

// Listeners are registered at the top level, as MV3 service workers require.
api.runtime.onMessage.addListener((message) => {
  if (message?.type !== MESSAGE_TYPE) return;
  if (!isValidPayload(message.payload)) {
    console.warn(`${LOG_PREFIX} dropped a malformed payload`);
    return;
  }
  handleCapture(message.payload).catch((error) =>
    console.error(`${LOG_PREFIX} cannot handle a capture:`, error),
  );
});

api.alarms.create(FLUSH_ALARM_NAME, { periodInMinutes: FLUSH_PERIOD_MINUTES });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FLUSH_ALARM_NAME) return;
  flushQueue().catch(reportFlushFailure);
});

// The payload comes from page-controlled messages, so it is checked at this boundary.
function isValidPayload(payload) {
  return (
    REQUIRED_TEXT_FIELDS.every((field) => typeof payload?.[field] === "string") &&
    URL.canParse(payload.url)
  );
}

function describeRecord(record) {
  // Only the path: query strings can carry tokens.
  return new URL(record.url).pathname;
}

async function handleCapture(payload) {
  const record = { ...payload, extension_version: api.runtime.getManifest().version };
  try {
    await sendToReceiver(record);
  } catch (error) {
    if (error instanceof RecordRejectedError) {
      console.warn(`${LOG_PREFIX} dropped a record: ${error.message}`);
      return;
    }
    if (!(error instanceof RetryLaterError)) throw error;
    await enqueue(record);
  }
}

async function enqueue(record) {
  const key = `${QUEUE_KEY_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
  await api.storage.local.set({ [key]: record });
}

// Loads the whole storage at once. That is fine because the queue is normally
// empty and only grows during a long receiver outage.
async function flushQueue() {
  const stored = await api.storage.local.get(null);
  const queueKeys = Object.keys(stored)
    .filter((key) => key.startsWith(QUEUE_KEY_PREFIX))
    .sort();
  for (const key of queueKeys) {
    try {
      await sendToReceiver(stored[key]);
    } catch (error) {
      if (!(error instanceof RecordRejectedError)) throw error;
      console.warn(`${LOG_PREFIX} dropped a queued record: ${error.message}`);
    }
    await api.storage.local.remove(key);
  }
}

// A retry-later failure is systemic (receiver off, wrong secret), so the flush
// stops at the first one and it is reported once per run, not once per record.
function reportFlushFailure(error) {
  if (error instanceof MissingSecretError) {
    console.warn(`${LOG_PREFIX} queue kept: ${error.message}`);
  } else if (error instanceof RetryLaterError) {
    console.debug(`${LOG_PREFIX} queue kept: ${error.message}`);
  } else {
    console.error(`${LOG_PREFIX} queue flush failed:`, error);
  }
}

async function readSecret() {
  const stored = await api.storage.local.get(SECRET_STORAGE_KEY);
  const secret = stored[SECRET_STORAGE_KEY];
  if (!secret) {
    throw new MissingSecretError(`secret is not set under "${SECRET_STORAGE_KEY}"`);
  }
  return secret;
}

function isNetworkFailure(error) {
  return error instanceof TypeError || error.name === "TimeoutError";
}

async function postRecord(record, secret) {
  try {
    return await fetch(RECEIVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SECRET_HEADER]: secret },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    // Only network failures mean "receiver is off"; anything else is a bug and must surface.
    if (!isNetworkFailure(error)) throw error;
    throw new RetryLaterError(`receiver unreachable (${error.name})`, { cause: error });
  }
}

async function sendToReceiver(record) {
  const secret = await readSecret();
  const response = await postRecord(record, secret);
  if (response.ok) return;
  const description = `receiver answered ${response.status} for ${describeRecord(record)}`;
  const isRetryable =
    response.status === HTTP_UNAUTHORIZED || response.status >= HTTP_SERVER_ERROR_MIN;
  throw isRetryable ? new RetryLaterError(description) : new RecordRejectedError(description);
}
