'use strict';

const nock = require('nock');
const { receiveMessage, sendHeartbeat } = require('../src/wosClient');

const WOS_BASE = 'http://127.0.0.1:8080';

afterEach(() => nock.cleanAll());

describe('receiveMessage', () => {
  test('resolves on code=1', async () => {
    nock(WOS_BASE)
      .post('/api/receiveMessage', { event: 'newMessage', data: { msgType: 'text' } })
      .reply(200, { code: 1, msg: 'ok', data: {} });

    const result = await receiveMessage({ event: 'newMessage', data: { msgType: 'text' } });
    expect(result.code).toBe(1);
  });

  test('throws on code!=1', async () => {
    nock(WOS_BASE)
      .post('/api/receiveMessage')
      .reply(200, { code: 0, msg: 'error' });

    await expect(receiveMessage({ event: 'e', data: {} })).rejects.toThrow(/code=0/);
  });

  test('throws on network error', async () => {
    nock(WOS_BASE)
      .post('/api/receiveMessage')
      .replyWithError('ECONNREFUSED');

    await expect(receiveMessage({ event: 'e', data: {} })).rejects.toThrow();
  });

  test('sends file ref in envelope when provided', async () => {
    nock(WOS_BASE)
      .post('/api/receiveMessage', (body) => body.file === 'https://cdn/img.jpg')
      .reply(200, { code: 1, msg: 'ok' });

    const result = await receiveMessage({
      event: 'newMessage',
      data: { msgType: 'image' },
      file: 'https://cdn/img.jpg',
    });
    expect(result.code).toBe(1);
  });
});

describe('sendHeartbeat', () => {
  test('resolves on 200', async () => {
    nock(WOS_BASE).post('/api/heartbeat').reply(200, { code: 1 });
    await expect(sendHeartbeat()).resolves.toBeUndefined();
  });

  test('throws on network error', async () => {
    nock(WOS_BASE).post('/api/heartbeat').replyWithError('timeout');
    await expect(sendHeartbeat()).rejects.toThrow();
  });
});
