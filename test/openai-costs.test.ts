import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchOrganizationCostsMtd,
  formatOrganizationCostsReport,
  sumOrganizationCostBuckets,
  sumOrganizationUsageTokens,
  type CostsFetch,
  type OrganizationCostBucket,
  type OrganizationCostsPage,
  type OrganizationUsageBucket,
  type OrganizationUsagePage,
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

test('sumOrganizationUsageTokens sums completions input and output', () => {
  const buckets: OrganizationUsageBucket[] = [
    {
      results: [
        {
          object: 'organization.usage.completions.result',
          input_tokens: 1000,
          output_tokens: 250,
        },
        {
          object: 'organization.costs.result',
          input_tokens: 9999,
          output_tokens: 9999,
        },
        {
          object: 'organization.usage.completions.result',
          input_tokens: -5,
          output_tokens: Number.NaN,
        },
      ],
    },
    {
      results: [
        {
          object: 'organization.usage.completions.result',
          input_tokens: 500,
          output_tokens: 50,
        },
      ],
    },
  ];
  const totals = sumOrganizationUsageTokens(buckets);
  assert.equal(totals.inputTokens, 1500);
  assert.equal(totals.outputTokens, 300);
  assert.equal(totals.totalTokens, 1800);
});

test('formatOrganizationCostsReport uses Russian billing wording', () => {
  const text = formatOrganizationCostsReport({
    periodStartMoscow: '2026-03-01',
    totalValue: 12.34,
    currency: 'usd',
    daysWithData: 12,
    inputTokens: 10000,
    outputTokens: 2500,
    truncated: false,
  });
  assert.match(text, /Расходы организации OpenAI \(биллинг Admin API\):/);
  assert.match(text, /Период: 2026-03-01 … сейчас \(Europe\/Moscow\)/);
  assert.match(text, /Итого: \$12\.34 USD/);
  assert.match(text, /Токены: 12500 \(in 10000 \/ out 2500\)/);
  assert.match(text, /Дней с данными: 12/);
  assert.match(text, /не оценка бота из \/usage/);
  assert.doesNotMatch(text, /\/stats/);
});

function jsonResponse(body: OrganizationCostsPage | OrganizationUsagePage, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('fetchOrganizationCostsMtd paginates costs and usage and sums both', async () => {
  const calls: URL[] = [];
  const fetchImpl: CostsFetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);

    if (url.pathname === '/v1/organization/costs') {
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
    }

    assert.equal(url.origin + url.pathname, 'https://api.openai.com/v1/organization/usage/completions');
    assert.equal(url.searchParams.get('bucket_width'), '1d');
    assert.equal(url.searchParams.get('limit'), '31');
    if (!url.searchParams.get('page')) {
      return jsonResponse({
        object: 'page',
        has_more: true,
        next_page: 'usage-2',
        data: [
          {
            object: 'bucket',
            results: [
              {
                object: 'organization.usage.completions.result',
                input_tokens: 1000,
                output_tokens: 200,
              },
            ],
          },
        ],
      });
    }
    assert.equal(url.searchParams.get('page'), 'usage-2');
    return jsonResponse({
      object: 'page',
      has_more: false,
      next_page: null,
      data: [
        {
          object: 'bucket',
          results: [
            {
              object: 'organization.usage.completions.result',
              input_tokens: 500,
              output_tokens: 50,
            },
          ],
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

  assert.equal(calls.filter((url) => url.pathname === '/v1/organization/costs').length, 2);
  assert.equal(calls.filter((url) => url.pathname === '/v1/organization/usage/completions').length, 2);
  assert.equal(report.totalValue, 12.34);
  assert.equal(report.daysWithData, 2);
  assert.equal(report.periodStartMoscow, '2026-03-01');
  assert.equal(report.currency, 'usd');
  assert.equal(report.inputTokens, 1500);
  assert.equal(report.outputTokens, 250);
  assert.equal(report.truncated, false);

  const startTime = Number(calls[0]!.searchParams.get('start_time'));
  const endTime = Number(calls[0]!.searchParams.get('end_time'));
  assert.equal(startTime, Math.floor(zonedMoscowTime(2026, 3, 1, 0, 0, 0).getTime() / 1000));
  assert.equal(endTime, Math.floor(now.getTime() / 1000));
});

test('fetchOrganizationCostsMtd stops at page cap and marks truncated', async () => {
  let costsPages = 0;
  let usagePages = 0;
  const fetchImpl: CostsFetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/organization/costs') {
      costsPages += 1;
      return jsonResponse({
        object: 'page',
        has_more: true,
        next_page: `cursor-${costsPages + 1}`,
        data: [
          {
            object: 'bucket',
            results: [{ object: 'organization.costs.result', amount: { value: 1, currency: 'usd' } }],
          },
        ],
      });
    }
    usagePages += 1;
    return jsonResponse({
      object: 'page',
      has_more: false,
      next_page: null,
      data: [
        {
          object: 'bucket',
          results: [
            {
              object: 'organization.usage.completions.result',
              input_tokens: 10,
              output_tokens: 1,
            },
          ],
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

  assert.equal(costsPages, 2);
  assert.equal(usagePages, 1);
  assert.equal(report.totalValue, 2);
  assert.equal(report.inputTokens, 10);
  assert.equal(report.outputTokens, 1);
  assert.equal(report.truncated, true);
});
