import { HttpsProxyAgent } from 'https-proxy-agent';
import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

const invalidProxyUrlMessage =
  'Expected empty or an http, https, socks5, or socks5h proxy URL with host and port';
const agentOptions = { keepAlive: true, timeout: 60_000 };
const agents = new Map<string, HttpsProxyAgent<string> | SocksProxyAgent>();

export function parseTelegramProxyUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(invalidProxyUrlMessage);
  }
  const port = Number(url.port);
  const allowed = url.protocol === 'http:'
    || url.protocol === 'https:'
    || url.protocol === 'socks5:'
    || url.protocol === 'socks5h:';
  if (!allowed || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(invalidProxyUrlMessage);
  }
  return url;
}

export function proxyLogLabel(url: URL): string {
  return `${url.protocol.slice(0, -1)} ${url.host}`;
}

export function createTelegramProxyAgent(url: URL) {
  if (url.protocol === 'socks5:' || url.protocol === 'socks5h:') {
    return new SocksProxyAgent(url, agentOptions);
  }
  return new HttpsProxyAgent(url, agentOptions);
}

function sharedTelegramProxyAgent(proxyUrl: string) {
  const key = proxyUrl.trim();
  if (!key) return undefined;
  const cached = agents.get(key);
  if (cached) return cached;
  const url = parseTelegramProxyUrl(key);
  if (!url) return undefined;
  const agent = createTelegramProxyAgent(url);
  agents.set(key, agent);
  return agent;
}

export function telegramBotOptions(proxyUrl: string) {
  const agent = sharedTelegramProxyAgent(proxyUrl);
  if (!agent) return undefined;
  return { client: { baseFetchConfig: { agent } } };
}

export async function telegramFileFetch(proxyUrl: string, fileUrl: string) {
  const agent = sharedTelegramProxyAgent(proxyUrl);
  if (!agent) return fetch(fileUrl);
  return nodeFetch(fileUrl, { agent });
}
