/**
 * Configuration – read from environment variables with sensible defaults.
 *
 * Environment variables:
 *   WEFLOW_SSE_URL        WeFlow local SSE endpoint (default: http://127.0.0.1:9527/sse/messages)
 *   WEFLOW_PULL_URL       WeFlow message pull endpoint (default: http://127.0.0.1:9527/messages)
 *   WOS_BASE_URL          Work-Order-System base URL (default: http://127.0.0.1:8080)
 *   WOS_RECEIVE_PATH      receiveMessage path (default: /api/receiveMessage)
 *   WOS_UPLOAD_PATH       File upload path     (default: /api/uploadFile)
 *   WOS_HEARTBEAT_PATH    Heartbeat path       (default: /api/heartbeat)
 *   HEARTBEAT_INTERVAL_MS Heartbeat period ms  (default: 30000)
 *   RECONNECT_DELAY_MS    SSE reconnect delay  (default: 5000)
 *   REQUEST_TIMEOUT_MS    HTTP request timeout (default: 10000)
 */

'use strict';

const config = {
  weflow: {
    sseUrl: process.env.WEFLOW_SSE_URL || 'http://127.0.0.1:9527/sse/messages',
    pullUrl: process.env.WEFLOW_PULL_URL || 'http://127.0.0.1:9527/messages',
  },
  wos: {
    baseUrl: process.env.WOS_BASE_URL || 'http://127.0.0.1:8080',
    receivePath: process.env.WOS_RECEIVE_PATH || '/api/receiveMessage',
    uploadPath: process.env.WOS_UPLOAD_PATH || '/api/uploadFile',
    heartbeatPath: process.env.WOS_HEARTBEAT_PATH || '/api/heartbeat',
  },
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10),
  reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS || '5000', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
};

module.exports = config;
