'use strict';

const http = require('http');
const crypto = require('crypto');
const transport = require('../runner/codex-transport');
const { scrubSecrets } = require('../runner/safety');
const { BRIDGE_ERROR_TYPE, retryMetadata } = require('../runner/model-retry');

// This service owns the upstream token. The caller presents a DIFFERENT local
// token; incoming headers are never copied into the upstream request.
function createHost({ callerToken, env = process.env, upstreamUrl, onShutdown = () => {} }) {
  if (!callerToken || callerToken.length < 32) throw new Error('A strong local caller token is required');
  const upstreamEnv = { CODEX_ACCESS_TOKEN: transport.resolveAccessToken(env) };
  const expected = Buffer.from('Bearer ' + callerToken);
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const authenticated = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    const json = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    // Browser origins have no role here. Do not turn a website into a caller.
    if (req.headers.origin || !authenticated) {
      json(401, { error: 'Local caller authentication required' });
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      json(200, { status: 'ok', service: 'codex-local-bridge', activeRequests: active.size });
      return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      json(200, { status: 'stopping' });
      for (const controller of active) controller.abort();
      server.close(onShutdown);
      server.closeIdleConnections();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      json(404, { error: 'Unknown endpoint' });
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => controller.abort());
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          json(413, { error: 'Request too large' });
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = transport.normalizeRequestBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        json(400, { error: 'Invalid Responses request' });
        return;
      }
      await transport.requestStream(
        body,
        (event) => {
          if (!res.headersSent)
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          res.write('data: ' + JSON.stringify(event) + '\n\n');
          // Bound buffered output if a client stops reading while generation runs.
          if (res.writableLength > 8 * 1024 * 1024) controller.abort();
        },
        { env: upstreamEnv, url: upstreamUrl, signal: controller.signal },
      );
      res.end();
    } catch (err) {
      if (res.destroyed) return;
      const message = scrubSecrets(err.message);
      const retry = retryMetadata(err);
      const error = { type: BRIDGE_ERROR_TYPE, version: 1, message, retry };
      if (!res.headersSent) {
        // Rebuild only the numeric delay header. Forwarding all upstream
        // headers could disclose cookies or account-specific identifiers.
        const headers = retry.retryAfterMs === undefined ? {} : { 'retry-after': String(retry.retryAfterMs / 1000) };
        json(retry.statusCode || 502, { error }, headers);
      } else {
        // HTTP headers cannot change once streaming starts. The same small
        // envelope carries classification through a final error event instead.
        res.end('data: ' + JSON.stringify({ type: 'error', error }) + '\n\n');
      }
    } finally {
      active.delete(controller);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
module.exports = { createHost };
