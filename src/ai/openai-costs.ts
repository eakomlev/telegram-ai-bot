import { config } from '../config.js';
import { moscowDateString, moscowMonthStart } from '../core/moscow-time.js';
import { formatUsd } from './usage.js';

const COSTS_ENDPOINT = 'https://api.openai.com/v1/organization/costs';
const USAGE_COMPLETIONS_ENDPOINT = 'https://api.openai.com/v1/organization/usage/completions';
const BUCKET_WIDTH = '1d';
// Moscow MTD can span 32 UTC day buckets (MSK = UTC+3); costs API allows up to 180.
const COSTS_BUCKET_LIMIT = 32;
// Completions usage API max for bucket_width=1d is 31.
const USAGE_BUCKET_LIMIT = 31;
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

export type OrganizationUsageCompletionsResult = {
  object?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
};

export type OrganizationUsageBucket = {
  object?: string;
  start_time?: number;
  end_time?: number;
  results?: OrganizationUsageCompletionsResult[] | null;
};

export type OrganizationUsagePage = {
  object?: string;
  data?: OrganizationUsageBucket[] | null;
  has_more?: boolean;
  next_page?: string | null;
};

export type OrganizationCostsTotals = {
  totalValue: number;
  currency: string;
  daysWithData: number;
};

export type OrganizationUsageTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type OrganizationCostsReport = {
  periodStartMoscow: string;
  totalValue: number;
  currency: string;
  daysWithData: number;
  inputTokens: number;
  outputTokens: number;
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

/** Sum completions input/output tokens across usage buckets. */
export function sumOrganizationUsageTokens(buckets: OrganizationUsageBucket[]): OrganizationUsageTokenTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const bucket of buckets) {
    for (const result of bucket.results ?? []) {
      if (result.object !== 'organization.usage.completions.result') continue;
      const input = result.input_tokens;
      const output = result.output_tokens;
      if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
        inputTokens += Math.floor(input);
      }
      if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
        outputTokens += Math.floor(output);
      }
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** Russian reply body for owner `/costs`. */
export function formatOrganizationCostsReport(report: OrganizationCostsReport): string {
  const currencyLabel = report.currency.trim().toUpperCase() || 'USD';
  const tokens = report.inputTokens + report.outputTokens;
  return [
    'Статистика по OpenAI',
    '',
    `Период: ${report.periodStartMoscow} … сейчас`,
    `Итого: ${formatUsd(report.totalValue)} ${currencyLabel}`,
    `Токены: ${tokens} (in ${report.inputTokens} / out ${report.outputTokens})`,
    `Дней с данными: ${report.daysWithData}`,
  ].join('\n');
}

function buildAdminUsageUrl(params: {
  endpoint: string;
  startTime: number;
  endTime: number;
  limit: number;
  page?: string;
}): string {
  const query = new URLSearchParams({
    start_time: String(params.startTime),
    end_time: String(params.endTime),
    bucket_width: BUCKET_WIDTH,
    limit: String(params.limit),
  });
  if (params.page) query.set('page', params.page);
  return `${params.endpoint}?${query}`;
}

async function fetchAdminJsonPage<T>(opts: {
  endpoint: string;
  adminApiKey: string;
  startTime: number;
  endTime: number;
  limit: number;
  page?: string;
  timeoutMs: number;
  fetchImpl: CostsFetch;
  errorLabel: string;
}): Promise<T> {
  const response = await opts.fetchImpl(
    buildAdminUsageUrl({
      endpoint: opts.endpoint,
      startTime: opts.startTime,
      endTime: opts.endTime,
      limit: opts.limit,
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
    throw new Error(`${opts.errorLabel} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchAllBuckets<TBucket, TPage extends {
  data?: TBucket[] | null;
  has_more?: boolean;
  next_page?: string | null;
}>(opts: {
  endpoint: string;
  adminApiKey: string;
  startTime: number;
  endTime: number;
  limit: number;
  timeoutMs: number;
  fetchImpl: CostsFetch;
  maxPages: number;
  errorLabel: string;
}): Promise<{ buckets: TBucket[]; truncated: boolean }> {
  const buckets: TBucket[] = [];
  let page: string | undefined;
  let truncated = false;

  for (let pageIndex = 0; pageIndex < opts.maxPages; pageIndex += 1) {
    const body = await fetchAdminJsonPage<TPage>({
      endpoint: opts.endpoint,
      adminApiKey: opts.adminApiKey,
      startTime: opts.startTime,
      endTime: opts.endTime,
      limit: opts.limit,
      page,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      errorLabel: opts.errorLabel,
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
    if (pageIndex === opts.maxPages - 1) {
      truncated = true;
    }
  }

  return { buckets, truncated };
}

/**
 * Fetch organization spend and completions tokens for the current Moscow
 * calendar month (MTD) via Admin API. Ignores OPENAI_BASE_URL.
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
      inputTokens: 0,
      outputTokens: 0,
      truncated: false,
    };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? config.OPENAI_TIMEOUT_MS;
  const maxPages = opts?.maxPages ?? MAX_PAGES;
  const shared = { adminApiKey, startTime, endTime, timeoutMs, fetchImpl, maxPages };

  const [costsPage, usagePage] = await Promise.all([
    fetchAllBuckets<OrganizationCostBucket, OrganizationCostsPage>({
      ...shared,
      endpoint: COSTS_ENDPOINT,
      limit: COSTS_BUCKET_LIMIT,
      errorLabel: 'OpenAI costs API',
    }),
    fetchAllBuckets<OrganizationUsageBucket, OrganizationUsagePage>({
      ...shared,
      endpoint: USAGE_COMPLETIONS_ENDPOINT,
      limit: USAGE_BUCKET_LIMIT,
      errorLabel: 'OpenAI usage completions API',
    }),
  ]);

  const totals = sumOrganizationCostBuckets(costsPage.buckets);
  const tokens = sumOrganizationUsageTokens(usagePage.buckets);
  return {
    periodStartMoscow: moscowDateString(periodStart),
    totalValue: totals.totalValue,
    currency: totals.currency,
    daysWithData: totals.daysWithData,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    truncated: costsPage.truncated || usagePage.truncated,
  };
}
