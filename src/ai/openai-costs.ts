import { config } from '../config.js';
import { moscowDateString, moscowMonthStart } from '../core/moscow-time.js';
import { formatUsd } from './usage.js';

const COSTS_ENDPOINT = 'https://api.openai.com/v1/organization/costs';
const BUCKET_WIDTH = '1d';
// Moscow MTD can span 32 UTC day buckets (MSK = UTC+3); API allows up to 180.
const BUCKET_LIMIT = 32;
const MAX_PAGES = 5;

export type CostsFetch = typeof fetch;

export type OrganizationCostAmount = {
  value?: number | null;
  currency?: string | null;
};

export type OrganizationCostResult = {
  object?: string;
  amount?: OrganizationCostAmount | null;
};

export type OrganizationCostBucket = {
  object?: string;
  start_time?: number;
  end_time?: number;
  results?: OrganizationCostResult[] | null;
};

export type OrganizationCostsPage = {
  object?: string;
  data?: OrganizationCostBucket[] | null;
  has_more?: boolean;
  next_page?: string | null;
};

export type OrganizationCostsTotals = {
  totalValue: number;
  currency: string;
  daysWithData: number;
};

export type OrganizationCostsReport = {
  periodStartMoscow: string;
  totalValue: number;
  currency: string;
  daysWithData: number;
  truncated: boolean;
};

/** Sum `organization.costs.result` amounts across daily buckets. */
export function sumOrganizationCostBuckets(buckets: OrganizationCostBucket[]): OrganizationCostsTotals {
  let totalValue = 0;
  let currency = 'usd';
  let daysWithData = 0;
  let currencyLocked = false;

  for (const bucket of buckets) {
    let dayHasAmount = false;
    for (const result of bucket.results ?? []) {
      if (result.object !== 'organization.costs.result') continue;
      const value = result.amount?.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      totalValue += value;
      dayHasAmount = true;
      const resultCurrency = result.amount?.currency?.trim();
      if (!currencyLocked && resultCurrency) {
        currency = resultCurrency.toLowerCase();
        currencyLocked = true;
      }
    }
    if (dayHasAmount) daysWithData += 1;
  }

  return { totalValue, currency, daysWithData };
}

/** Russian reply body for owner `/costs`. */
export function formatOrganizationCostsReport(report: OrganizationCostsReport): string {
  const currencyLabel = report.currency.trim().toUpperCase() || 'USD';
  return [
    'Расходы организации OpenAI (биллинг Admin API):',
    `Период: ${report.periodStartMoscow} … сейчас (Europe/Moscow)`,
    `Итого: ${formatUsd(report.totalValue)} ${currencyLabel}`,
    `Дней с данными: ${report.daysWithData}`,
    '',
    'Это официальный биллинг организации OpenAI, а не оценка бота из /usage.',
  ].join('\n');
}

function buildCostsUrl(params: {
  startTime: number;
  endTime: number;
  page?: string;
}): string {
  const query = new URLSearchParams({
    start_time: String(params.startTime),
    end_time: String(params.endTime),
    bucket_width: BUCKET_WIDTH,
    limit: String(BUCKET_LIMIT),
  });
  if (params.page) query.set('page', params.page);
  return `${COSTS_ENDPOINT}?${query}`;
}

async function fetchCostsPage(opts: {
  adminApiKey: string;
  startTime: number;
  endTime: number;
  page?: string;
  timeoutMs: number;
  fetchImpl: CostsFetch;
}): Promise<OrganizationCostsPage> {
  const response = await opts.fetchImpl(
    buildCostsUrl({
      startTime: opts.startTime,
      endTime: opts.endTime,
      page: opts.page,
    }),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.adminApiKey}`,
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(`OpenAI costs API failed with status ${response.status}`);
  }
  return (await response.json()) as OrganizationCostsPage;
}

/**
 * Fetch organization spend for the current Moscow calendar month (MTD)
 * via Admin API GET /v1/organization/costs. Ignores OPENAI_BASE_URL.
 */
export async function fetchOrganizationCostsMtd(opts?: {
  now?: Date;
  adminApiKey?: string;
  timeoutMs?: number;
  fetchImpl?: CostsFetch;
  maxPages?: number;
}): Promise<OrganizationCostsReport> {
  const now = opts?.now ?? new Date();
  const adminApiKey = (opts?.adminApiKey ?? config.OPENAI_ADMIN_API_KEY).trim();
  if (!adminApiKey) {
    throw new Error('OPENAI_ADMIN_API_KEY is not configured');
  }

  const periodStart = moscowMonthStart(now);
  const startTime = Math.floor(periodStart.getTime() / 1000);
  const endTime = Math.floor(now.getTime() / 1000);
  if (endTime <= startTime) {
    return {
      periodStartMoscow: moscowDateString(periodStart),
      totalValue: 0,
      currency: 'usd',
      daysWithData: 0,
      truncated: false,
    };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? config.OPENAI_TIMEOUT_MS;
  const maxPages = opts?.maxPages ?? MAX_PAGES;
  const buckets: OrganizationCostBucket[] = [];
  let page: string | undefined;
  let truncated = false;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const body = await fetchCostsPage({
      adminApiKey,
      startTime,
      endTime,
      page,
      timeoutMs,
      fetchImpl,
    });
    buckets.push(...(body.data ?? []));
    if (!body.has_more) {
      truncated = false;
      break;
    }
    const nextPage = body.next_page?.trim();
    if (!nextPage) {
      truncated = true;
      break;
    }
    page = nextPage;
    if (pageIndex === maxPages - 1) {
      truncated = true;
    }
  }

  const totals = sumOrganizationCostBuckets(buckets);
  return {
    periodStartMoscow: moscowDateString(periodStart),
    totalValue: totals.totalValue,
    currency: totals.currency,
    daysWithData: totals.daysWithData,
    truncated,
  };
}
