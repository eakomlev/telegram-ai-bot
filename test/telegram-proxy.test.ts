import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
  createTelegramProxyAgent,
  parseTelegramProxyUrl,
  proxyLogLabel,
  telegramBotOptions,
} from '../src/telegram-proxy.js';

const invalidProxyUrl = /Expected empty or an http, https, socks5, or socks5h proxy URL with host and port/;

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
  assert.equal(first.client.baseFetchConfig.agent, second?.client.baseFetchConfig.agent);
  assert.ok(first.client.baseFetchConfig.agent instanceof HttpsProxyAgent);
  const socksOptions = telegramBotOptions('socks5://10.0.0.1:1080');
  assert.ok(socksOptions?.client.baseFetchConfig.agent instanceof SocksProxyAgent);
});
