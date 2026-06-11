'use strict';

const { sendHeartbeat } = require('./wosClient');
const config = require('./config');

/**
 * Start a periodic heartbeat to the Work-Order-System so that the downstream
 * service can detect whether the bridge is alive.
 *
 * @returns {{ stop: function(): void }}  Handle with a stop() method
 */
function startHeartbeat() {
  const timer = setInterval(async () => {
    try {
      await sendHeartbeat();
      console.log('[heartbeat] OK');
    } catch (err) {
      console.warn('[heartbeat] Failed:', err.message);
    }
  }, config.heartbeatIntervalMs);

  // Avoid keeping the Node process alive solely for the heartbeat
  if (timer.unref) {
    timer.unref();
  }

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { startHeartbeat };
