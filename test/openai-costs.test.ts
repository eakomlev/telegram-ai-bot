import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchOrganizationCostsMtd,
  formatOrganizationCostsReport,
  sumOrganizationCostBuckets,
  type CostsFetch,
  type OrganizationCostBucket,
  type OrganizationCostsPage,
} from '../src/ai/openai-costs.js';
import { zonedMoscowTime } from '../src/core/moscow-time.js';

const sampleBuckets: OrganizationCostBucket[] = [
  {
    object: 'bucket',
    start_time: 1,
    end_time: 2,
    results: [
      {
        object: 'organization.costs.result',
        amount: { value: 1.2, currency: 'usd' },
      },
      {
        object: 'organization.usage.completions.result',
        amount: { value: 99, currency: 'usd' },
      },
    ],
  },
  {
    object: 'bucket',
    start_time: 2,
    end_time: 3,
    results: [
      {
        object: 'organization.costs.result',
        amount: { value: 0.05, currency: 'usd' },
      },
    ],
  },
  {
    object: 'bucket',
    start_time: 3,
    end_time: 4,
    results: [
      {
        object: 'organization.costs.result',
        amount: null,
      },
      {
        object: 'organization.costs.result',
      },
    ],
  },
];

test('sumOrganizationCostBuckets sums cost results and counts days with data', () => {
  const totals = sumOrganizationCostBuckets(sampleBuckets);
  assert.equal(totals.totalValue, 1.25);
  assert.equal(totals.currency, 'usd');
  assert.equal(totals.daysWithData, 2);
});

test('sumOrganizationCostBuckets skips missing amount and keeps first currency', () => {
  const totals = sumOrganizationCostBuckets([
    {
      results: [
        { object: 'organization.costs.result', amount: { value: 2, currency: 'eur' } },
        { object: 'organization.costs.result', amount: { value: 3, currency: 'usd' } },
        { object: 'organization.costs.result', amount: { value: Number.NaN, currency: 'usd' } },
      ],
    },
  ]);
  assert.equal(totals.totalValue, 5);
  assert.equal(totals.currency, 'eur');
  assert.equal(totals.daysWithData, 1);
});

test('formatOrganizationCostsReport uses Russian billing wording', () => {
  const text = formatOrganizationCostsReport({
    periodStartMoscow: '2026-03-01',
    totalValue: 12.34,
    currency: 'usd',
    daysWithData: 12,
    truncated: false,
  });
  assert.match(text, /Расходы организации OpenAI \(биллинг Admin API\):/);
  assert.match(text, /Период: 2026-03-01 … сейчас \(Europe\/Moscow\)/);
  assert.match(text, /Итого: \$12\.34 USD/);
  assert.match(text, /Дней с данными: 12/);
  assert.match(text, /не оценка бота из \/usage/);
  assert.doesNotMatch(text, /\/stats/);
});

function jsonResponse(body: OrganizationCostsPage, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('fetchOrganizationCostsMtd paginates with page cursor and sums buckets', async () => {
  const calls: URL[] = [];
  const fetchImpl: CostsFetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin + url.pathname, 'https://api.openai.com/v1/organization/costs');
    assert.equal(url.searchParams.get('bucket_width'), '1d');
    assert.equal(url.searchParams.get('limit'), '32');
    assert.ok(!url.searchParams.has('group_by'));

    if (!url.searchParams.get('page')) {
      return jsonResponse({
        object: 'page',
        has_more: true,
        next_page: 'cursor-2',
        data: [
          {
            object: 'bucket',
            results: [{ object: 'organization.costs.result', amount: { value: 10, currency: 'usd' } }],
          },
        ],
      });
    }
    assert.equal(url.searchParams.get('page'), 'cursor-2');
    return jsonResponse({
      object: 'page',
      has_more: false,
      next_page: null,
      data: [
        {
          object: 'bucket',
          results: [{ object: 'organization.costs.result', amount: { value: 2.34, currency: 'usd' } }],
        },
      ],
    });
  };

  const now = zonedMoscowTime(2026, 3, 18, 12, 0, 0);
  const report = await fetchOrganizationCostsMtd({
    now,
    adminApiKey: 'sk-admin-test',
    fetchImpl,
    timeoutMs: 5_000,
  });

  assert.equal(calls.length, 2);
  assert.equal(report.totalValue, 12.34);
  assert.equal(report.daysWithData, 2);
  assert.equal(report.periodStartMoscow, '2026-03-01');
  assert.equal(report.currency, 'usd');
  assert.equal(report.truncated, false);

  const startTime = Number(calls[0]!.searchParams.get('start_time'));
  const endTime = Number(calls[0]!.searchParams.get('end_time'));
  assert.equal(startTime, Math.floor(zonedMoscowTime(2026, 3, 1, 0, 0, 0).getTime() / 1000));
  assert.equal(endTime, Math.floor(now.getTime() / 1000));
});

test('fetchOrganizationCostsMtd stops at page cap and marks truncated', async () => {
  let page = 0;
  const fetchImpl: CostsFetch = async () => {
    page += 1;
    return jsonResponse({
      object: 'page',
      has_more: true,
      next_page: `cursor-${page + 1}`,
      data: [
        {
          object: 'bucket',
          results: [{ object: 'organization.costs.result', amount: { value: 1, currency: 'usd' } }],
        },
      ],
    });
  };

  const report = await fetchOrganizationCostsMtd({
    now: zonedMoscowTime(2026, 3, 10, 12, 0, 0),
    adminApiKey: 'sk-admin-test',
    fetchImpl,
    maxPages: 2,
  });

  assert.equal(page, 2);
  assert.equal(report.totalValue, 2);
  assert.equal(report.truncated, true);
});
