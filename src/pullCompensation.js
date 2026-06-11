'use strict';

const axios = require('axios');
const { handleMessage } = require('./messageHandler');
const config = require('./config');

/**
 * Pull missed messages from WeFlow since the given cursor (last seen message ID)
 * and forward each one to WOS.
 *
 * This is invoked after an SSE reconnect to compensate for any messages that
 * arrived during the disconnection window.
 *
 * WeFlow pull endpoint: GET /messages?since=<lastId>
 * Expected response: { code: 1, data: [ { id, event, data } ] }
 *
 * @param {string|number|null} lastId  Last successfully processed message ID,
 *                                     or null to skip compensation.
 * @returns {Promise<string|number|null>}  The newest message ID that was processed
 *                                         (or lastId if nothing was pulled).
 */
async function pullCompensation(lastId) {
  if (lastId === null || lastId === undefined) {
    return lastId;
  }

  const url = config.weflow.pullUrl;
  let response;
  try {
    response = await axios.get(url, {
      params: { since: lastId },
      timeout: config.requestTimeoutMs,
    });
  } catch (err) {
    console.error('[pullCompensation] Failed to pull messages from WeFlow:', err.message);
    return lastId;
  }

  const body = response.data;
  if (!body || body.code !== 1 || !Array.isArray(body.data)) {
    console.warn('[pullCompensation] Unexpected WeFlow pull response:', body);
    return lastId;
  }

  const messages = body.data;
  if (messages.length === 0) {
    return lastId;
  }

  let latestId = lastId;
  for (const msg of messages) {
    try {
      await handleMessage(msg.event, msg.data);
      latestId = msg.id;
      console.log(`[pullCompensation] Compensated message id=${msg.id}, event=${msg.event}`);
    } catch (err) {
      console.error(`[pullCompensation] Failed to process message id=${msg.id}:`, err.message);
    }
  }
  return latestId;
}

module.exports = { pullCompensation };
