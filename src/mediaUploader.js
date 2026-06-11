'use strict';

const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');

/**
 * Upload a media buffer/stream to the Work-Order-System and return the file
 * reference string that the downstream `receiveMessage` API expects.
 *
 * Two-step process:
 *   1. POST multipart/form-data to WOS /api/uploadFile
 *   2. Extract `data.fileRef` (or `data.url`) from the response
 *
 * @param {object} params
 * @param {Buffer|import('stream').Readable} params.content  File content
 * @param {string}  params.filename  Original filename (e.g. "photo.jpg")
 * @param {string}  params.mimetype  MIME type (e.g. "image/jpeg")
 * @returns {Promise<string>}  File reference returned by WOS
 */
async function uploadMedia({ content, filename, mimetype }) {
  const form = new FormData();
  form.append('file', content, { filename, contentType: mimetype });

  const url = config.wos.baseUrl + config.wos.uploadPath;
  const response = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: config.requestTimeoutMs,
  });

  const body = response.data;
  if (!body || body.code !== 1) {
    throw new Error(
      `Media upload failed: code=${body && body.code}, msg=${body && body.msg}`
    );
  }

  const fileRef = (body.data && (body.data.fileRef || body.data.url)) || null;
  if (!fileRef) {
    throw new Error('Media upload response missing data.fileRef / data.url');
  }
  return fileRef;
}

module.exports = { uploadMedia };
