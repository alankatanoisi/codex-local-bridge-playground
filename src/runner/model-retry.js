'use strict';

// Retrying an invalid request cannot repair it. Only these temporary failures
// earn another attempt; unknown errors stop rather than guessing from prose.
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']);
const MAX_RETRY_WAIT_MS = 30000;
const BRIDGE_ERROR_TYPE = 'codex_bridge_error';

// A relay must carry the reason for failure, rather than turning every error
// into a retryable 502. Copy only classification fields, never raw headers,
// credentials, stacks, or arbitrary properties attached to an Error object.
function retryMetadata(error) {
  const metadata = {};
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
    metadata.statusCode = error.statusCode;
  }
  if (RETRYABLE_NETWORK_CODES.has(error?.code)) metadata.code = error.code;
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    metadata.retryAfterMs = error.retryAfterMs;
  }
  return metadata;
}

function readBridgeRetryMetadata(error) {
  if (error?.type !== BRIDGE_ERROR_TYPE || error.version !== 1) return null;
  // An empty result deliberately means "unclassified". It must not inherit
  // the relay's generic HTTP 502 status and accidentally become retryable.
  return retryMetadata(error.retry);
}

function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Retry-After can be a number of seconds or an HTTP date. Do not retain
  // the raw header, which could contain unrelated server information.
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    // Even an overflowing number means "wait too long", never "retry now".
    return Number.isFinite(milliseconds) ? milliseconds : MAX_RETRY_WAIT_MS + 1;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryDelayMs(error, retriesSoFar) {
  if (error.statusCode !== undefined) {
    if (!RETRYABLE_STATUS_CODES.has(error.statusCode)) return null;
  } else if (!RETRYABLE_NETWORK_CODES.has(error.code)) {
    return null;
  }
  const serverWait = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs) : 0;
  // A long server pause ends this bounded run. Clamping it DOWN would send
  // another request earlier than the server asked us to, so do not do that.
  if (serverWait > MAX_RETRY_WAIT_MS) return null;
  return Math.max(Math.min(250 * 2 ** retriesSoFar, 2000), serverWait);
}

module.exports = {
  parseRetryAfter,
  retryDelayMs,
  MAX_RETRY_WAIT_MS,
  BRIDGE_ERROR_TYPE,
  retryMetadata,
  readBridgeRetryMetadata,
};
