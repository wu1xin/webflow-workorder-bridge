'use strict';

const axios = require('axios');
const config = require('./config');

/**
 * Send a message envelope to the Work-Order-System's receiveMessage endpoint.
 *
 * Envelope schema: { event, data, file? }
 *   - event  {string}  The WeFlow event name (e.g. "newMessage")
 *   - data   {object}  The message payload
 *   - file   {string}  [optional] File reference returned by uploadMedia
 *
 * Success criterion: response body `code === 1`
 *
 * @param {object} envelope  { event, data, file? }
 * @returns {Promise<object>}  Full WOS response body
 * @throws  {Error}           When WOS returns code !== 1 or the request fails
 */
async function receiveMessage(envelope) {
  const url = config.wos.baseUrl + config.wos.receivePath;
  const response = await axios.post(url, envelope, {
    headers: { 'Content-Type': 'application/json' },
    timeout: config.requestTimeoutMs,
  });

  const body = response.data;
  if (!body || body.code !== 1) {
    throw new Error(
      `receiveMessage rejected: code=${body && body.code}, msg=${body && body.msg}`
    );
  }
  return body;
}

/**
 * Send a heartbeat to the Work-Order-System.
 *
 * @returns {Promise<void>}
 */
async function sendHeartbeat() {
  const url = config.wos.baseUrl + config.wos.heartbeatPath;
  await axios.post(url, {}, {
    headers: { 'Content-Type': 'application/json' },
    timeout: config.requestTimeoutMs,
  });
}

module.exports = { receiveMessage, sendHeartbeat };
