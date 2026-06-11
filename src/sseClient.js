'use strict';

const EventSource = require('eventsource');
const { handleMessage } = require('./messageHandler');
const { pullCompensation } = require('./pullCompensation');
const config = require('./config');

/**
 * Create and manage an SSE connection to WeFlow.
 *
 * On each 'message' event the bridge:
 *   1. Parses the JSON payload
 *   2. Delegates to handleMessage() which either passes text through or does
 *      a two-step media upload before forwarding to WOS
 *   3. Records the last successfully seen message id for pull compensation
 *
 * On connection error / close the bridge waits `reconnectDelayMs` then
 * reconnects, calling pullCompensation() first to recover any missed messages.
 *
 * @returns {{ stop: function(): void }}  Handle with a stop() method
 */
function startSseClient() {
  let lastId = null;
  let es = null;
  let stopped = false;
  let reconnectTimer = null;

  function connect() {
    if (stopped) return;

    console.log(`[sseClient] Connecting to ${config.weflow.sseUrl}`);
    es = new EventSource(config.weflow.sseUrl);

    es.onopen = () => {
      console.log('[sseClient] Connected');
    };

    es.onmessage = async (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch (err) {
        console.error('[sseClient] Failed to parse SSE data:', event.data);
        return;
      }

      const eventName = event.type || parsed.event || 'message';
      const data = parsed.data !== undefined ? parsed.data : parsed;
      const msgId = parsed.id || event.lastEventId || null;

      try {
        await handleMessage(eventName, data);
        if (msgId !== null) {
          lastId = msgId;
        }
      } catch (err) {
        console.error(`[sseClient] handleMessage failed (event=${eventName}):`, err.message);
      }
    };

    es.onerror = async (err) => {
      console.error('[sseClient] SSE error, will reconnect:', err && err.message);
      es.close();

      if (stopped) return;

      // Pull compensation before reconnecting
      try {
        lastId = await pullCompensation(lastId);
      } catch (e) {
        console.error('[sseClient] pullCompensation error:', e.message);
      }

      reconnectTimer = setTimeout(connect, config.reconnectDelayMs);
    };
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (es) es.close();
    },
  };
}

module.exports = { startSseClient };
