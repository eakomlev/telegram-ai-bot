import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVideoLink, validateVideoMetadata, videoCaption } from '../src/media/video-utils.js';
import { runProcess } from '../src/core/process.js';

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

test('rejects live, playlists and invalid or excessive duration', () => {
  validateVideoMetadata({ duration: 60 }, 180);
  validateVideoMetadata({}, 180); // platforms like Instagram may omit duration pre-download
  for (const info of [{ duration: 181 }, { duration: NaN }, { duration: -1 },
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
  assert.equal(await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value], 2000), value);
});

test('process runner rejects nonzero exit', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)'], 2000), /process failed/);
});

test('process runner terminates a real process on timeout', async () => {
  const started = Date.now();
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 100), /timed out/);
  assert.ok(Date.now() - started < 5000, 'timeout must terminate before natural exit');
});

test('process runner terminates a real process on cancellation', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const job = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 15000, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(job, /cancelled/); }
  finally { clearTimeout(timer); }
  assert.ok(Date.now() - started < 5000, 'abort must terminate before natural exit');
});

test('process runner terminates on excessive stdout', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(5 * 1024 * 1024)); setTimeout(() => {}, 10000)'], 5000), /output limit/);
});


test('process timeout also terminates descendants holding stdout open', async () => {
  const started = Date.now();
  const script = "const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e','setTimeout(()=>{},10000)'], {stdio:['ignore','inherit','inherit']}); setTimeout(()=>{},10000);";
  await assert.rejects(runProcess(process.execPath, ['-e', script], 400), /timed out/);
  assert.ok(Date.now() - started < 5000, 'descendant must not retain the process pipes');
});
