'use strict';

function assertSessionPath(filePath) {
  // State, ledger, cursor and autopsy files share a naming convention.
  // Without this ending, replacing the suffix can leave the SAME filename,
  // allowing an event log to overwrite the saved conversation.
  if (typeof filePath !== 'string' || !filePath.endsWith('.state.json')) {
    const error = new Error('Session path must end in .state.json (for example, session.state.json).');
    error.code = 'session_path_invalid';
    throw error;
  }
  return filePath;
}

module.exports = { assertSessionPath };
