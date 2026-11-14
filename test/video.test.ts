import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVideoLink, validateVideoMetadata, videoCaption } from '../src/video-utils.js';
import { runProcess } from '../src/process.js';

test('recognizes only standalone short-video links on supported hosts', () => {
  for (const link of ['https://youtube.com/shorts/abc-123?si=tracking', 'https://youtu.be/abc',
    'https://www.tiktok.com/@author/video/123', 'https://www.tiktok.com/t/Zabc123/', 'https://vm.tiktok.com/abc/',
    'https://www.instagram.com/reel/abc_123/', 'https://vk.com/clip-123_456']) {
    assert.ok(parseVideoLink(link), link);
  }
  assert.equal(parseVideoLink('https://youtube.com/shorts/abc?si=tracking')?.url, 'https://youtube.com/shorts/abc');
  for (const link of ['https://example.com/shorts/a', 'http://youtube.com/shorts/a',
    'https://youtube.com.evil.com/shorts/a', 'https://user:pass@youtube.com/shorts/a',
    'https://youtube.com:444/shorts/a', 'Смотри https://youtube.com/shorts/a',
    'https://youtube.com/shorts/a https://youtube.com/shorts/b',
    'https://youtube.com/watch?v=a', 'https://instagram.com/p/abc/',
    'https://127.0.0.1/shorts/a', 'file:///tmp/movie.mp4', 'https://tiktok.com/@author']) {
    assert.equal(parseVideoLink(link), undefined, link);
  }
});

test('rejects live, playlists and unknown or excessive duration', () => {
  validateVideoMetadata({ duration: 60 }, 180);
  for (const info of [{ duration: 181 }, {}, { duration: NaN }, { duration: -1 },
    { duration: 60, is_live: true }, { duration: 60, _type: 'playlist' },
    { duration: 60, live_status: 'is_upcoming' }]) {
    assert.throws(() => validateVideoMetadata(info, 180));
  }
});

test('caption contains metadata, bounded description and always preserves source', () => {
  const source = parseVideoLink('https://instagram.com/reel/abc/')!;
  const caption = videoCaption({ title: 'Ролик', uploader: 'Автор', upload_date: '20261114',
    duration: 55, view_count: 1200, like_count: 30, description: '😀'.repeat(2000) }, source);
  assert.ok(caption.length <= 1024);
  for (const value of ['Ролик', 'Автор', '2026-11-14', '55 сек.', 'Просмотры:', 'Лайки:', source.url]) assert.ok(caption.includes(value));
  assert.ok(caption.endsWith(source.url));
});

test('process runner does not interpret shell metacharacters', async () => {
  const value = '$(echo dangerous); echo other';
  assert.equal(await runProcess('/bin/echo', [value], 2000), value + '\n');
});

test('process runner rejects failures, timeout and cancellation', async () => {
  await assert.rejects(runProcess('/bin/false', [], 2000));
  await assert.rejects(runProcess('/bin/sleep', ['5'], 50));
  const controller = new AbortController();
  const job = runProcess('/bin/sleep', ['5'], 2000, controller.signal);
  controller.abort();
  await assert.rejects(job);
});
