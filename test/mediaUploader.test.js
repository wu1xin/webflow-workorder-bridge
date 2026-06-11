'use strict';

const nock = require('nock');
const FormData = require('form-data');
const { uploadMedia } = require('../src/mediaUploader');

const WOS_BASE = 'http://127.0.0.1:8080';

afterEach(() => nock.cleanAll());

describe('uploadMedia', () => {
  test('returns fileRef on success', async () => {
    nock(WOS_BASE)
      .post('/api/uploadFile')
      .reply(200, { code: 1, data: { fileRef: 'https://cdn/img.jpg' } });

    const content = Buffer.from('fake-image');
    const ref = await uploadMedia({ content, filename: 'img.jpg', mimetype: 'image/jpeg' });
    expect(ref).toBe('https://cdn/img.jpg');
  });

  test('falls back to data.url when data.fileRef is absent', async () => {
    nock(WOS_BASE)
      .post('/api/uploadFile')
      .reply(200, { code: 1, data: { url: 'https://cdn/video.mp4' } });

    const ref = await uploadMedia({
      content: Buffer.from('vid'),
      filename: 'video.mp4',
      mimetype: 'video/mp4',
    });
    expect(ref).toBe('https://cdn/video.mp4');
  });

  test('throws when code != 1', async () => {
    nock(WOS_BASE)
      .post('/api/uploadFile')
      .reply(200, { code: 0, msg: 'storage error' });

    await expect(
      uploadMedia({ content: Buffer.from('x'), filename: 'x.txt', mimetype: 'text/plain' })
    ).rejects.toThrow(/upload failed/i);
  });

  test('throws when response missing file reference', async () => {
    nock(WOS_BASE)
      .post('/api/uploadFile')
      .reply(200, { code: 1, data: {} });

    await expect(
      uploadMedia({ content: Buffer.from('x'), filename: 'x.txt', mimetype: 'text/plain' })
    ).rejects.toThrow(/fileRef/);
  });

  test('throws on network error', async () => {
    nock(WOS_BASE).post('/api/uploadFile').replyWithError('ECONNREFUSED');

    await expect(
      uploadMedia({ content: Buffer.from('x'), filename: 'x.bin', mimetype: 'application/octet-stream' })
    ).rejects.toThrow();
  });
});
