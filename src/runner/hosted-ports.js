'use strict';

const safety = require('./safety');

// A UI is an observer, not an owner of the runner's result objects. Give it a
// redacted copy and contain both synchronous throws and rejected promises.
function notifyObserver(callback, value) {
  if (typeof callback !== 'function') return;
  try {
    Promise.resolve(callback(safety.scrubObject(value))).catch(() => {});
  } catch {
    /* Display failures must not interrupt tool-result bookkeeping. */
  }
}

function createApprovalPort(base, injected, signal) {
  if (injected && typeof injected.ask !== 'function') throw new Error('confirm.ask must be a function');
  const port = injected || base;
  return {
    ask(action, timeoutMs, metadata = {}) {
      if (signal?.aborted) return Promise.resolve('deny');
      return new Promise((resolve) => {
        let finished = false;
        let timer;
        const finish = (choice) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          // Anything except an explicit allow is a denial, including UI errors.
          resolve(choice === 'allow' && !signal?.aborted ? 'allow' : 'deny');
        };
        const cancel = () => finish('deny');
        signal?.addEventListener('abort', cancel, { once: true });
        if (timeoutMs > 0) timer = setTimeout(cancel, timeoutMs);
        Promise.resolve()
          .then(() => {
            if (finished || signal?.aborted) return 'deny';
            return port.ask(safety.scrubSecrets(action), timeoutMs, { ...safety.scrubObject(metadata), signal });
          })
          .then(finish, cancel);
      });
    },
  };
}

module.exports = { notifyObserver, createApprovalPort };
