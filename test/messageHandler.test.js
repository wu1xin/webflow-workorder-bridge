'use strict';

const { isMediaMessage, handleMessage } = require('../src/messageHandler');

jest.mock('../src/mediaUploader', () => ({
  uploadMedia: jest.fn().mockResolvedValue('https://wos.example/files/abc.jpg'),
}));

jest.mock('../src/wosClient', () => ({
  receiveMessage: jest.fn().mockResolvedValue({ code: 1, msg: 'ok' }),
}));

const { uploadMedia } = require('../src/mediaUploader');
const { receiveMessage } = require('../src/wosClient');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isMediaMessage', () => {
  test('text message is not media', () => {
    expect(isMediaMessage({ msgType: 'text' })).toBe(false);
  });

  test('markdown message is not media', () => {
    expect(isMediaMessage({ msgType: 'markdown' })).toBe(false);
  });

  test('image message is media', () => {
    expect(isMediaMessage({ msgType: 'image' })).toBe(true);
  });

  test('voice message is media', () => {
    expect(isMediaMessage({ msgType: 'voice' })).toBe(true);
  });

  test('file message is media', () => {
    expect(isMediaMessage({ msgType: 'file' })).toBe(true);
  });

  test('video message is media', () => {
    expect(isMediaMessage({ msgType: 'video' })).toBe(true);
  });

  test('missing msgType defaults to text (non-media)', () => {
    expect(isMediaMessage({})).toBe(false);
    expect(isMediaMessage(null)).toBe(false);
  });
});

describe('handleMessage – text', () => {
  test('text message is forwarded directly without upload', async () => {
    const data = { msgType: 'text', content: 'hello' };
    await handleMessage('newMessage', data);

    expect(uploadMedia).not.toHaveBeenCalled();
    expect(receiveMessage).toHaveBeenCalledWith({ event: 'newMessage', data });
  });

  test('markdown message is forwarded directly without upload', async () => {
    const data = { msgType: 'markdown', content: '**bold**' };
    await handleMessage('msg', data);

    expect(uploadMedia).not.toHaveBeenCalled();
    expect(receiveMessage).toHaveBeenCalledWith({ event: 'msg', data });
  });
});

describe('handleMessage – media', () => {
  test('image message uploads then forwards with file ref', async () => {
    const mediaContent = Buffer.from('fake-image');
    const data = {
      msgType: 'image',
      media: { content: mediaContent, filename: 'photo.jpg', mimetype: 'image/jpeg' },
    };

    await handleMessage('newMessage', data);

    expect(uploadMedia).toHaveBeenCalledWith({
      content: mediaContent,
      filename: 'photo.jpg',
      mimetype: 'image/jpeg',
    });
    expect(receiveMessage).toHaveBeenCalledWith({
      event: 'newMessage',
      data,
      file: 'https://wos.example/files/abc.jpg',
    });
  });

  test('media message without media field throws', async () => {
    const data = { msgType: 'image' };
    await expect(handleMessage('newMessage', data)).rejects.toThrow(/media/i);
    expect(uploadMedia).not.toHaveBeenCalled();
  });
});

describe('handleMessage – WOS rejection', () => {
  test('propagates error when receiveMessage throws', async () => {
    receiveMessage.mockRejectedValueOnce(new Error('code=0'));
    const data = { msgType: 'text', content: 'hi' };
    await expect(handleMessage('newMessage', data)).rejects.toThrow('code=0');
  });
});
