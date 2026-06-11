'use strict';

const { uploadMedia } = require('./mediaUploader');
const { receiveMessage } = require('./wosClient');

/**
 * Determine whether a WeFlow message payload carries a media attachment.
 *
 * WeFlow encodes the message type in `data.msgType`.  Known text types:
 *   "text", "markdown"
 * Everything else (image, voice, video, file, …) is treated as media.
 *
 * @param {object} data  The raw WeFlow message payload
 * @returns {boolean}
 */
function isMediaMessage(data) {
  const textTypes = new Set(['text', 'markdown']);
  return !textTypes.has((data && data.msgType) || 'text');
}

/**
 * Process a single WeFlow SSE event and forward it to WOS.
 *
 * Text messages  → forward envelope directly: { event, data }
 * Media messages → upload attachment first, then forward: { event, data, file }
 *
 * @param {string} event        WeFlow event name
 * @param {object} data         Parsed message payload
 * @returns {Promise<object>}   WOS receiveMessage response body
 */
async function handleMessage(event, data) {
  let envelope;

  if (isMediaMessage(data)) {
    if (!data.media) {
      throw new Error(`Media message missing 'media' field: event=${event}`);
    }
    const fileRef = await uploadMedia({
      content: data.media.content,
      filename: data.media.filename || 'attachment',
      mimetype: data.media.mimetype || 'application/octet-stream',
    });
    envelope = { event, data, file: fileRef };
  } else {
    envelope = { event, data };
  }

  return receiveMessage(envelope);
}

module.exports = { handleMessage, isMediaMessage };
