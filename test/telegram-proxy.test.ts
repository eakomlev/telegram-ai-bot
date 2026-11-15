import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
  createTelegramProxyAgent,
  parseTelegramApiRoot,
  parseTelegramProxyUrl,
  proxyLogLabel,
  telegramBotOptions,
  telegramFileUrl,
} from '../src/telegram-proxy.js';

const invalidProxyUrl = /Expected empty or an http, https, socks5, or socks5h proxy URL with host and port/;
const invalidApiRoot = /Expected empty or an absolute http\(s\) Telegram API root URL with host/;

function mustParse(value: string) {
  const url = parseTelegramProxyUrl(value);
  if (!url) throw new Error(`expected proxy url: ${value}`);
  return url;
}

test('empty and whitespace proxy means a direct connection', () => {
  for (const value of ['', ' ', '  ', '\t', '\n']) {
    assert.equal(parseTelegramProxyUrl(value), undefined);
    assert.equal(telegramBotOptions(value), undefined);
  }
});

test('accepts http, https, socks5, and socks5h proxy URLs', () => {
  const urls = [
    'http://127.0.0.1:8080',
    'https://proxy.example:8443',
    'socks5://10.0.0.1:1080',
    'socks5h://10.0.0.1:1080',
    'http://user:secret@127.0.0.1:8080',
  ];
  for (const value of urls) {
    const url = mustParse(value);
    const parsed = new URL(value);
    assert.equal(url.protocol, parsed.protocol);
    assert.equal(url.hostname, parsed.hostname);
    assert.equal(url.port, parsed.port);
    assert.equal(url.username, parsed.username);
    assert.equal(url.password, parsed.password);
  }
});

test('proxy log label hides credentials', () => {
  const url = mustParse('http://user:secret@127.0.0.1:8080');
  const label = proxyLogLabel(url);
  assert.equal(label, 'http 127.0.0.1:8080');
  assert.equal(label.includes('user'), false);
  assert.equal(label.includes('secret'), false);
  assert.equal(label.includes('http://'), false);
});

test('rejects proxy URLs without an allowed scheme, host, and port', () => {
  for (const value of [
    'not a url',
    'ftp://host:1',
    'socks4://host:1080',
    'http://host',
    'http://:8080',
    'http://host:65536',
  ]) {
    assert.throws(() => parseTelegramProxyUrl(value), invalidProxyUrl);
  }
});

test('creates http and socks agents without opening a socket', () => {
  const httpAgent = createTelegramProxyAgent(mustParse('http://127.0.0.1:8080'));
  const httpsAgent = createTelegramProxyAgent(mustParse('https://proxy.example:8443'));
  const socksAgent = createTelegramProxyAgent(mustParse('socks5://10.0.0.1:1080'));
  const socksHostAgent = createTelegramProxyAgent(mustParse('socks5h://10.0.0.1:1080'));
  assert.ok(httpAgent instanceof HttpsProxyAgent);
  assert.ok(httpsAgent instanceof HttpsProxyAgent);
  assert.ok(socksAgent instanceof SocksProxyAgent);
  assert.ok(socksHostAgent instanceof SocksProxyAgent);

  const first = telegramBotOptions('http://user:secret@127.0.0.1:8080');
  const second = telegramBotOptions('  http://user:secret@127.0.0.1:8080  ');
  assert.ok(first);
  assert.equal(first.client.baseFetchConfig?.agent, second?.client.baseFetchConfig?.agent);
  assert.ok(first.client.baseFetchConfig?.agent instanceof HttpsProxyAgent);
  const socksOptions = telegramBotOptions('socks5://10.0.0.1:1080');
  assert.ok(socksOptions?.client.baseFetchConfig?.agent instanceof SocksProxyAgent);
});

test('empty and whitespace API root means default Telegram host', () => {
  for (const value of ['', ' ', '  ', '\t', '\n']) {
    assert.equal(parseTelegramApiRoot(value), undefined);
  }
});

test('accepts absolute http(s) API roots and strips a trailing slash', () => {
  assert.equal(parseTelegramApiRoot('http://127.0.0.1:8081'), 'http://127.0.0.1:8081');
  assert.equal(parseTelegramApiRoot('http://127.0.0.1:8081/'), 'http://127.0.0.1:8081');
  assert.equal(parseTelegramApiRoot('https://api.example.com'), 'https://api.example.com');
  assert.equal(parseTelegramApiRoot('  https://api.example.com:8443/  '), 'https://api.example.com:8443');
});

test('rejects API roots with non-http(s), path, query, hash, or credentials', () => {
  for (const value of [
    'not a url',
    'ftp://127.0.0.1:8081',
    'socks5://127.0.0.1:1080',
    'http://',
    'http://127.0.0.1:8081/bot',
    'http://127.0.0.1:8081/api/v1',
    'http://127.0.0.1:8081?x=1',
    'http://127.0.0.1:8081#frag',
    'http://user:pass@127.0.0.1:8081',
  ]) {
    assert.throws(() => parseTelegramApiRoot(value), invalidApiRoot);
  }
});

test('telegramBotOptions composes apiRoot and proxy agent', () => {
  assert.equal(telegramBotOptions('', ''), undefined);
  assert.deepEqual(telegramBotOptions('', 'http://127.0.0.1:8081/'), {
    client: { apiRoot: 'http://127.0.0.1:8081' },
  });

  const proxyOnly = telegramBotOptions('http://127.0.0.1:8080');
  assert.ok(proxyOnly?.client.baseFetchConfig?.agent instanceof HttpsProxyAgent);
  assert.equal('apiRoot' in (proxyOnly?.client ?? {}), false);

  const both = telegramBotOptions('socks5://10.0.0.1:1080', 'https://api.example.com');
  assert.equal(both?.client.apiRoot, 'https://api.example.com');
  assert.ok(both?.client.baseFetchConfig?.agent instanceof SocksProxyAgent);
});

test('telegramFileUrl builds file download URLs', () => {
  assert.equal(
    telegramFileUrl('', 'TOKEN', 'photos/file.jpg'),
    'https://api.telegram.org/file/botTOKEN/photos/file.jpg',
  );
  assert.equal(
    telegramFileUrl('http://127.0.0.1:8081/', 'TOKEN', '/photos/file.jpg'),
    'http://127.0.0.1:8081/file/botTOKEN/photos/file.jpg',
  );
});
