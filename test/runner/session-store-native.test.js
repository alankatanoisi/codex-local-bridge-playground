'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nativeItems = require('../../src/runner/items');
const { SessionStore } = require('../../src/runner/session-store');
const { formatFatalError } = require('../../bin/local-bridge-runner');

describe('native SessionStore', () => {
  it('creates and persists a schema v2 Codex item history', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-session-store-'));
    const sessionPath = path.join(tmpDir, 'native.state.json');
    const store = new SessionStore(sessionPath);

    store.load();
    store.setItems([nativeItems.userMessage('hello')]);
    store.save();

    const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.provider, 'codex');
    assert.deepEqual(saved.items, [nativeItems.userMessage('hello')]);
    assert.equal('messages' in saved, false);
  });

  it('rejects a legacy v1 session without changing the file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-session-store-'));
    const sessionPath = path.join(tmpDir, 'legacy.state.json');
    const legacyText =
      JSON.stringify(
        {
          schemaVersion: 1,
          sessionId: 'ses_legacy',
          messages: [{ role: 'user', content: 'old history' }],
        },
        null,
        2,
      ) + '\n';
    fs.writeFileSync(sessionPath, legacyText, 'utf8');

    const store = new SessionStore(sessionPath);
    assert.throws(
      () => store.load(),
      (error) => {
        assert.equal(error.name, 'SessionSchemaError');
        assert.equal(error.code, 'session_schema_unsupported');
        assert.match(error.message, /cannot be resumed/i);
        return true;
      },
    );
    assert.equal(fs.readFileSync(sessionPath, 'utf8'), legacyText);
  });

  it('formats an unsupported legacy resume as an expected user error', () => {
    const error = new nativeItems.SessionSchemaError('Old session cannot be resumed.');
    assert.equal(formatFatalError(error), 'Error: Old session cannot be resumed.');
  });
});
