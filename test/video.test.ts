import assert from 'node:assert/strict';
import test from 'node:test';
import { formatVideoRepostError, parseVideoLink, validateVideoMetadata, videoCaption } from '../src/media/video-utils.js';
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

test('process runner includes distinctive stderr on nonzero exit', async () => {
  const marker = 'YTDLP_BOT_CHECK_SIGN_IN_UNIQUE';
  await assert.rejects(
    runProcess(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(marker)}); process.exit(1)`], 2000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /process failed/);
      assert.ok(error.message.includes(marker), error.message);
      return true;
    },
  );
});

test('process runner bounds stderr in Error.message for huge stderr', async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ['-e', `
      const fs = require('node:fs');
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      for (let i = 0; i < 40; i++) fs.writeSync(2, chunk);
      fs.writeSync(2, 'TAIL_MARKER_XYZ');
      process.exit(1);
    `], 5000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /process failed/);
      assert.ok(error.message.length < 4096, `message too long: ${error.message.length}`);
      assert.ok(error.message.includes('TAIL_MARKER_XYZ'), error.message);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'huge stderr must not hang rejection');
});

test('process runner success ignores stderr noise and returns stdout only', async () => {
  const out = await runProcess(process.execPath, ['-e', `
    process.stderr.write('noise\\x00\\x01 warn\\n');
    process.stdout.write('ok-payload');
  `], 2000);
  assert.equal(out, 'ok-payload');
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

const videoLimits = { maxDurationSeconds: 180, maxSizeMb: 45 };

test('formatVideoRepostError classifies bot-check without limit numbers', () => {
  const text = formatVideoRepostError(
    new Error('process failed: ERROR: Sign in to confirm you’re not a bot'),
    videoLimits,
  );
  assert.ok(text.includes('доступ') || /огранич|бот|вход/i.test(text), text);
  assert.ok(!text.includes('сек.'), text);
  assert.ok(!text.includes('МБ'), text);
  assert.ok(!/cookie/i.test(text), text);
});

test('formatVideoRepostError classifies duration and size limits', () => {
  const duration = formatVideoRepostError(new Error('duration'), videoLimits);
  assert.ok(duration.includes(`${videoLimits.maxDurationSeconds} сек.`), duration);
  const size = formatVideoRepostError(new Error('size'), videoLimits);
  assert.ok(size.includes(`${videoLimits.maxSizeMb} МБ`), size);
  const filesize = formatVideoRepostError(
    new Error('process failed: File is larger than max-filesize'),
    videoLimits,
  );
  assert.ok(filesize.includes(`${videoLimits.maxSizeMb} МБ`), filesize);
});

test('formatVideoRepostError classifies timeout without false limit blame', () => {
  const text = formatVideoRepostError(new Error('process timed out'), videoLimits);
  assert.ok(/ожидания|тайм|время/i.test(text), text);
  assert.ok(!text.includes('сек.'), text);
  assert.ok(!text.includes('МБ'), text);
});

test('formatVideoRepostError unknown and non-Error stay access-first without primary limits', () => {
  const unknown = formatVideoRepostError(new Error('process failed: some obscure extractor boom'), videoLimits);
  assert.ok(/доступ|закрыт/i.test(unknown), unknown);
  assert.ok(!unknown.includes(`${videoLimits.maxDurationSeconds} сек.`), unknown);
  assert.ok(!unknown.includes(`${videoLimits.maxSizeMb} МБ`), unknown);
  const nonError = formatVideoRepostError('weird', videoLimits);
  assert.ok(/доступ|закрыт|загрузить/i.test(nonError), nonError);
  assert.ok(!nonError.includes(`${videoLimits.maxDurationSeconds} сек.`), nonError);
  assert.ok(!nonError.includes(`${videoLimits.maxSizeMb} МБ`), nonError);
});
