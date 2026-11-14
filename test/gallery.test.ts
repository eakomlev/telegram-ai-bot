import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from 'grammy';
import { parseGalleryLink, galleryCaption } from '../src/gallery-utils.js';
import { repostGallery } from '../src/gallery.js';

test('accepts individual supported posts, rejects profiles and arbitrary URLs', () => {
  for (const url of ['https://instagram.com/p/abc_123/', 'https://x.com/user/status/123',
    'https://twitter.com/user/status/123?s=20', 'https://reddit.com/r/test/comments/abc123/title/',
    'https://www.pixiv.net/en/artworks/123', 'https://imgur.com/a/Abc12']) assert.ok(parseGalleryLink(url), url);
  for (const url of ['https://instagram.com/reel/abc', 'https://x.com/user', 'https://imgur.com/user/name',
    'https://evil.com/p/abc', 'https://instagram.com.evil.com/p/abc', 'https://a:b@instagram.com/p/abc',
    'http://instagram.com/p/abc', 'https://instagram.com:8000/p/abc', 'https://127.0.0.1/p/abc',
    'текст https://instagram.com/p/abc', 'https://pixiv.net/users/123']) assert.equal(parseGalleryLink(url), undefined, url);
});
test('normalizes author, text and date without losing source in long captions', () => {
  const source = parseGalleryLink('https://x.com/person/status/123')!;
  const caption = galleryCaption({ user: { name: 'Аня' }, content: 'Описание '.repeat(200),
    date: '2026-11-14T12:00:00', favorite_count: 25 }, source, true);
  assert.ok(caption.length <= 1024);
  for (const value of ['Аня', 'Описание', '2026-11-14', 'Лайки: 25', source.url, 'лимита']) assert.ok(caption.includes(value));
});

for (const count of [1, 3]) {
  test(`posts ${count === 1 ? 'a single photo' : 'an album'} with source metadata and cleans temporary files`, async () => {
    let directory = '';
    const calls: unknown[][] = [];
    const fakeRun = async (command: string, args: string[]) => {
      if (command === 'gallery-dl') {
        directory = args[args.indexOf('--directory') + 1]!;
        for (let index = 0; index < count; index++) {
          await writeFile(join(directory, `${index}.jpg`), 'image');
          await writeFile(join(directory, `${index}.jpg.json`), JSON.stringify({ title: 'Пост', user: { name: 'Аня' } }));
        }
      } else {
        assert.equal(command, 'ffmpeg');
        await writeFile(args.at(-1)!, 'converted image');
      }
      return '';
    };
    const ctx = { message: { message_id: 5, message_thread_id: 12 }, chat: { id: -123 },
      reply: async () => ({ message_id: 99 }),
      replyWithChatAction: async () => {},
      api: { deleteMessage: async () => {}, editMessageText: async () => {} },
      replyWithPhoto: async (...args: unknown[]) => { calls.push(args); },
      replyWithMediaGroup: async (...args: unknown[]) => { calls.push(args); },
    } as unknown as Context;
    await repostGallery(ctx, parseGalleryLink('https://instagram.com/p/abc/')!, fakeRun);
    assert.equal(calls.length, 1);
    const opts = calls[0]![1] as { message_thread_id: number; reply_parameters: { message_id: number }; caption?: string };
    assert.equal(opts.message_thread_id, 12);
    assert.equal(opts.reply_parameters.message_id, 5);
    const caption = count === 1 ? opts.caption : (calls[0]![0] as { caption?: string }[])[0]?.caption;
    assert.ok(caption?.includes('Аня'));
    assert.ok(caption?.includes('https://instagram.com/p/abc/'));
    if (count > 1) assert.equal((calls[0]![0] as unknown[]).length, count);
    await assert.rejects(access(directory));
  });
}
test('failed extraction replies without raw errors and removes temporary files', async () => {
  let directory = '';
  let response = '';
  const ctx = { message: { message_id: 5 }, chat: { id: -123 },
    reply: async () => ({ message_id: 99 }),
    replyWithChatAction: async () => {},
    api: {
      deleteMessage: async () => {},
      editMessageText: async (_chat: number, _id: number, value: string) => { response = value; },
    },
  } as unknown as Context;
  await repostGallery(ctx, parseGalleryLink('https://imgur.com/a/abc')!, async (_command, args) => {
    directory = args[args.indexOf('--directory') + 1]!;
    throw new Error('private signed URL');
  });
  assert.match(response, /Не удалось/);
  assert.ok(!response.includes('private'));
  await assert.rejects(access(directory));
});

test('photo upload failure also cleans downloaded and converted files', async () => {
  let directory = '';
  let replied = false;
  const ctx = { message: { message_id: 5 }, chat: { id: -123 },
    reply: async () => ({ message_id: 99 }),
    replyWithChatAction: async () => {},
    api: {
      deleteMessage: async () => {},
      editMessageText: async () => { replied = true; },
    },
    replyWithPhoto: async () => { throw new Error('Telegram unavailable'); },
  } as unknown as Context;
  await repostGallery(ctx, parseGalleryLink('https://imgur.com/a/abc')!, async (command, args) => {
    if (command === 'gallery-dl') {
      directory = args[args.indexOf('--directory') + 1]!;
      await writeFile(join(directory, 'photo.jpg'), 'image');
      await writeFile(join(directory, 'photo.jpg.json'), '{}');
    } else await writeFile(args.at(-1)!, 'converted');
    return '';
  });
  assert.equal(replied, true);
  await assert.rejects(access(directory));
});

test('images and videos share worker capacity and per-chat cooldown', async () => {
  const { enqueueMedia } = await import('../src/media-jobs.js');
  let release!: () => void;
  let busy = false;
  const first = { chat: { id: -101 }, reply: async () => assert.fail('Unexpected reply') } as unknown as Context;
  const second = { chat: { id: -102 }, reply: async () => { busy = true; } } as unknown as Context;
  await enqueueMedia(first, () => new Promise<void>((resolve) => { release = resolve; }));
  await enqueueMedia(second, async () => assert.fail('Shared worker limit ignored'));
  assert.equal(busy, true);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await enqueueMedia(first, async () => assert.fail('Per-chat cooldown ignored'));
});
