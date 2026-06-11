'use strict';

const { startSseClient } = require('./sseClient');
const { startHeartbeat } = require('./heartbeat');

console.log('[bridge] Starting WeFlow → WOS bridge…');

const sseHandle = startSseClient();
const heartbeatHandle = startHeartbeat();

function shutdown(signal) {
  console.log(`[bridge] Received ${signal}, shutting down…`);
  sseHandle.stop();
  heartbeatHandle.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
