'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createHost } = require('../../src/hosting/server');
const transport = require('../../src/runner/codex-transport');

// The upstream substitute records which credential it received. This proves
// the host does not forward the caller's local token to the model service.
describe('Standalone Codex host', () => {
  it('separates credentials, streams Responses, and requires auth for control', async () => {
    let upstreamAuth,
      calls = 0;
    const upstream = http.createServer((req, res) => {
      calls++;
      upstreamAuth = req.headers.authorization;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          'data: ' +
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } },
            }) +
            '\n\n',
        );
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const callerToken = 'sk-local-' + 'a'.repeat(64);
    const host = createHost({
      callerToken,
      env: { CODEX_ACCESS_TOKEN: 'at-upstream-fixture' },
      upstreamUrl: 'http://127.0.0.1:' + upstream.address().port,
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + host.address().port;
    try {
      assert.equal((await fetch(base + '/health')).status, 401);
      assert.equal((await fetch(base + '/shutdown', { method: 'POST' })).status, 401);
      assert.equal(
        (
          await fetch(base + '/health', {
            headers: { authorization: 'Bearer ' + callerToken, origin: 'https://example.com' },
          })
        ).status,
        401,
      );
      const result = await transport.requestBuffered(
        { model: 'gpt-6.1-sol', input: [], max_output_tokens: 16 },
        {
          env: { CODEX_BRIDGE_URL: base + '/v1/responses', CODEX_BRIDGE_CALLER_TOKEN: callerToken },
        },
      );
      assert.equal(result.response.status, 'completed');
      assert.equal(calls, 1);
      assert.equal(upstreamAuth, 'Bearer at-upstream-fixture');
      assert.equal(
        (await fetch(base + '/health', { headers: { authorization: 'Bearer ' + callerToken } })).status,
        200,
      );
      const stopped = new Promise((resolve) => host.once('close', resolve));
      assert.equal(
        (await fetch(base + '/shutdown', { method: 'POST', headers: { authorization: 'Bearer ' + callerToken } }))
          .status,
        200,
      );
      await stopped;
    } finally {
      host.closeAllConnections();
      host.close();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
  it('rejects a nonlocal bridge or conflicting endpoint before networking', async () => {
    assert.throws(
      () =>
        transport.requestBuffered(
          {},
          { env: { CODEX_BRIDGE_URL: 'http://example.com', CODEX_BRIDGE_CALLER_TOKEN: 'local' } },
        ),
      /loopback/,
    );
    assert.throws(
      () =>
        transport.requestBuffered(
          {},
          {
            url: 'https://example.com',
            env: { CODEX_BRIDGE_URL: 'http://127.0.0.1:1', CODEX_BRIDGE_CALLER_TOKEN: 'local' },
          },
        ),
      /Conflicting/,
    );
  });
});

describe('Host process lifecycle', () => {
  it('starts a detached process, reports status, and shuts down without a model call', async () => {
    const fs = require('fs'),
      os = require('os'),
      path = require('path');
    const { promisify } = require('util');
    const exec = promisify(require('child_process').execFile);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-host-process-'));
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const call = (verb, withToken = true) =>
      exec(process.execPath, [path.resolve('bin/codex-host.js'), verb, '--state-dir', dir, '--port', String(port)], {
        env: { ...process.env, CODEX_ACCESS_TOKEN: withToken ? 'at-fake-host-lifecycle' : '' },
        timeout: 10000,
      });
    try {
      assert.equal(JSON.parse((await call('start')).stdout).status, 'ok');
      const state = fs.readFileSync(path.join(dir, 'host.json'), 'utf8');
      assert.equal(state.includes('at-fake-host-lifecycle'), false);
      assert.equal(fs.statSync(path.join(dir, 'host.json')).mode & 0o777, 0o600);
      assert.equal(JSON.parse((await call('status')).stdout).activeRequests, 0);
      assert.equal(JSON.parse((await call('start', false)).stdout).alreadyRunning, true);
      assert.equal(JSON.parse((await call('stop')).stdout).status, 'stopping');
      for (let n = 0; n < 40 && fs.existsSync(path.join(dir, 'host.lock')); n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(fs.existsSync(path.join(dir, 'host.lock')), false);
    } finally {
      try {
        await call('stop');
      } catch {
        /* Already stopped. */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Host startup diagnostics', () => {
  it('reports an occupied port directly and leaves the existing listener untouched', async () => {
    const fs = require('fs'),
      os = require('os'),
      path = require('path');
    const exec = require('util').promisify(require('child_process').execFile);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-host-busy-'));
    const occupied = http.createServer((_req, res) => res.end('original listener'));
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const port = occupied.address().port;
    try {
      await assert.rejects(
        exec(
          process.execPath,
          [path.resolve('bin/codex-host.js'), 'start', '--state-dir', dir, '--port', String(port)],
          {
            env: { ...process.env, CODEX_ACCESS_TOKEN: 'at-fake-busy-port-test' },
            timeout: 4000,
          },
        ),
        (err) => {
          assert.match(err.stderr, /Port .* is already in use/);
          assert.equal(err.stderr.includes('did not become ready'), false);
          return true;
        },
      );
      assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'original listener');
      assert.equal(fs.existsSync(path.join(dir, 'host.json')), false);
      assert.equal(fs.existsSync(path.join(dir, 'host.lock')), false);
    } finally {
      occupied.closeAllConnections();
      await new Promise((resolve) => occupied.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
