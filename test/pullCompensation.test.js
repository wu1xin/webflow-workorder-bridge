'use strict';

const nock = require('nock');

const WEFLOW_BASE = 'http://127.0.0.1:9527';

// Must mock handleMessage before requiring pullCompensation
jest.mock('../src/messageHandler', () => ({
  handleMessage: jest.fn().mockResolvedValue({ code: 1 }),
}));

const { pullCompensation } = require('../src/pullCompensation');
const { handleMessage } = require('../src/messageHandler');

beforeEach(() => {
  jest.clearAllMocks();
  nock.cleanAll();
});

afterEach(() => nock.cleanAll());

describe('pullCompensation', () => {
  test('returns lastId unchanged when lastId is null', async () => {
    const result = await pullCompensation(null);
    expect(result).toBeNull();
  });

  test('returns lastId unchanged when pull response has no messages', async () => {
    nock(WEFLOW_BASE)
      .get('/messages')
      .query({ since: '10' })
      .reply(200, { code: 1, data: [] });

    const result = await pullCompensation('10');
    expect(result).toBe('10');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  test('processes pulled messages in order and returns latest id', async () => {
    nock(WEFLOW_BASE)
      .get('/messages')
      .query({ since: '5' })
      .reply(200, {
        code: 1,
        data: [
          { id: '6', event: 'newMessage', data: { msgType: 'text', content: 'a' } },
          { id: '7', event: 'newMessage', data: { msgType: 'text', content: 'b' } },
        ],
      });

    const result = await pullCompensation('5');
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenNthCalledWith(
      1,
      'newMessage',
      { msgType: 'text', content: 'a' }
    );
    expect(result).toBe('7');
  });

  test('continues processing remaining messages when one fails', async () => {
    handleMessage
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValueOnce({ code: 1 });

    nock(WEFLOW_BASE)
      .get('/messages')
      .query({ since: '10' })
      .reply(200, {
        code: 1,
        data: [
          { id: '11', event: 'newMessage', data: { msgType: 'image' } },
          { id: '12', event: 'newMessage', data: { msgType: 'text', content: 'ok' } },
        ],
      });

    const result = await pullCompensation('10');
    expect(handleMessage).toHaveBeenCalledTimes(2);
    // id 11 failed so latest successfully committed id is 12
    expect(result).toBe('12');
  });

  test('returns lastId when WeFlow pull request fails', async () => {
    nock(WEFLOW_BASE)
      .get('/messages')
      .query({ since: '3' })
      .replyWithError('ECONNREFUSED');

    const result = await pullCompensation('3');
    expect(result).toBe('3');
    expect(handleMessage).not.toHaveBeenCalled();
  });

  test('returns lastId on unexpected response shape', async () => {
    nock(WEFLOW_BASE)
      .get('/messages')
      .query({ since: '3' })
      .reply(200, { code: 0, msg: 'error' });

    const result = await pullCompensation('3');
    expect(result).toBe('3');
    expect(handleMessage).not.toHaveBeenCalled();
  });
});
