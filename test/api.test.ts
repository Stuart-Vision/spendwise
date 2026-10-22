// End-to-end tests of the Lambda handlers: each request is a real API Gateway
// (HTTP API, payload 2.0) event, and the data goes to an in-memory DynamoDB
// (dynalite) created with the same keys and index as template.yaml.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { S3Event } from 'aws-lambda';
import dynalite from 'dynalite';
import { createTable } from '../scripts/table.js';
import { apiEvent, matchRoute } from '../scripts/event.js';

let server: Server;
let routes: (typeof import('../scripts/routes.js'))['routes'];
let onReceiptUploaded: (typeof import('../src/handlers/onReceiptUploaded.js'))['main'];

before(async () => {
  server = dynalite({ createTableMs: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TABLE_NAME = 'spendwise-test';
  process.env.BUCKET_NAME = 'spendwise-test-receipts';
  await createTable(process.env.DYNAMODB_ENDPOINT, process.env.TABLE_NAME);
  ({ routes } = await import('../scripts/routes.js'));
  ({ main: onReceiptUploaded } = await import('../src/handlers/onReceiptUploaded.js'));
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface Response { status: number; body: any; headers: Record<string, string> }

/** Sends a request through the matching handler, like API Gateway would. */
async function call(method: string, path: string, opts: { user?: string | null; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Response> {
  const match = matchRoute(routes, method, path);
  assert.ok(match, `no route for ${method} ${path}`);
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.user) headers['x-user-id'] = opts.user;
  const event = apiEvent({
    method, route: match.route.path, path, headers, body: opts.body, query: opts.query,
    pathParameters: Object.keys(match.params).length ? match.params : undefined,
  });
  const r = await (match.route as (typeof routes)[number]).handler(event) as { statusCode: number; body: string; headers: Record<string, string> };
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined, headers: r.headers };
}

const lunch = { amountCents: 1250, currency: 'SGD', category: 'food', description: 'Chicken rice', date: '2026-10-21' };
const newUser = () => randomUUID();

describe('expenses', () => {
  test('create, read, list by month', async () => {
    const user = newUser();
    const created = await call('POST', '/expenses', { user, body: lunch });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.body.amountCents, 1250);

    await call('POST', '/expenses', { user, body: { ...lunch, description: 'MRT', category: 'transport', amountCents: 190, date: '2026-10-25' } });
    await call('POST', '/expenses', { user, body: { ...lunch, description: 'Last month', date: '2026-09-30' } });

    const got = await call('GET', `/expenses/${created.body.id}`, { user });
    assert.equal(got.status, 200);
    assert.equal(got.body.description, 'Chicken rice');
    assert.equal(got.body.receiptUrl, undefined);

    const list = await call('GET', '/expenses', { user, query: { month: '2026-10' } });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.expenses.map((e: any) => e.date), ['2026-10-25', '2026-10-21'], 'only October, newest first');
    assert.ok(!('pk' in list.body.expenses[0]), 'internal keys are not exposed');
  });

  test('users only ever see their own expenses', async () => {
    const alice = newUser();
    const bob = newUser();
    const { body: expense } = await call('POST', '/expenses', { user: alice, body: lunch });

    assert.equal((await call('GET', `/expenses/${expense.id}`, { user: bob })).status, 404);
    assert.equal((await call('DELETE', `/expenses/${expense.id}`, { user: bob })).status, 404);
    assert.equal((await call('POST', `/expenses/${expense.id}/receipt`, { user: bob, body: { contentType: 'image/png' } })).status, 404);
    assert.deepEqual((await call('GET', '/expenses', { user: bob, query: { month: '2026-10' } })).body.expenses, []);
    assert.equal((await call('GET', `/expenses/${expense.id}`, { user: alice })).status, 200, 'still there for its owner');
  });

  test('delete', async () => {
    const user = newUser();
    const { body: expense } = await call('POST', '/expenses', { user, body: lunch });
    assert.equal((await call('DELETE', `/expenses/${expense.id}`, { user })).status, 204);
    assert.equal((await call('GET', `/expenses/${expense.id}`, { user })).status, 404);
    assert.equal((await call('DELETE', `/expenses/${expense.id}`, { user })).status, 404);
  });

  test('a retried create with the same Idempotency-Key does not duplicate', async () => {
    const user = newUser();
    const headers = { 'Idempotency-Key': 'lunch-2026-10-21' };
    // Five identical requests at once, as a flaky mobile connection might send.
    const results = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/expenses', { user, body: lunch, headers })));

    assert.equal(new Set(results.map((r) => r.body.id)).size, 1, 'all get the same expense');
    assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one creates it');
    assert.ok(results.filter((r) => r.status === 200).every((r) => r.headers['idempotent-replayed'] === 'true'));
    assert.equal((await call('GET', '/expenses', { user, query: { month: '2026-10' } })).body.expenses.length, 1);

    // The same key from another user is a different expense.
    const other = await call('POST', '/expenses', { user: newUser(), body: lunch, headers });
    assert.equal(other.status, 201);
    assert.notEqual(other.body.id, results[0].body.id);
  });
});

describe('validation and errors', () => {
  const cases: [string, unknown, string][] = [
    ['negative amount', { ...lunch, amountCents: -5 }, 'invalid_request'],
    ['fractional cents', { ...lunch, amountCents: 12.5 }, 'invalid_request'],
    ['unknown currency', { ...lunch, currency: 'EUR' }, 'invalid_request'],
    ['impossible date', { ...lunch, date: '2026-02-30' }, 'invalid_request'],
    ['unexpected field', { ...lunch, userId: 'someone-else' }, 'invalid_request'],
    ['empty description', { ...lunch, description: '   ' }, 'invalid_request'],
    ['malformed JSON', '{"amountCents":', 'invalid_json'],
  ];
  for (const [name, body, code] of cases) {
    test(`rejects ${name}`, async () => {
      const r = await call('POST', '/expenses', { user: newUser(), body });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, code);
    });
  }

  test('requires a user', async () => {
    assert.equal((await call('POST', '/expenses', { user: null, body: lunch })).status, 401);
    assert.equal((await call('GET', '/expenses', { user: null, headers: { 'x-user-id': 'not-a-uuid' } })).status, 401);
  });

  test('rejects a bad month and a bad id', async () => {
    const user = newUser();
    assert.equal((await call('GET', '/expenses', { user, query: { month: '2026-13' } })).status, 400);
    assert.equal((await call('GET', '/expenses/not-an-id', { user })).status, 404);
  });
});

describe('receipts (S3)', () => {
  const s3Event = (key: string): S3Event => ({
    Records: [{ s3: { object: { key: encodeURIComponent(key).replace(/%2F/g, '/') } } } as S3Event['Records'][number]],
  });

  test('presigned upload, then the S3 event marks it uploaded', async () => {
    const user = newUser();
    const { body: expense } = await call('POST', '/expenses', { user, body: lunch });

    const upload = await call('POST', `/expenses/${expense.id}/receipt`, { user, body: { contentType: 'image/jpeg' } });
    assert.equal(upload.status, 200);
    assert.match(upload.body.url, /spendwise-test-receipts/);
    const key: string = upload.body.fields.key;
    assert.match(key, new RegExp(`^receipts/${user}/${expense.id}/[0-9a-f-]{36}\\.jpg$`));
    assert.equal(upload.body.fields['Content-Type'], 'image/jpeg');
    const policy = JSON.parse(Buffer.from(upload.body.fields.Policy, 'base64').toString());
    assert.deepEqual(policy.conditions.find((c: unknown) => Array.isArray(c) && c[0] === 'content-length-range'), ['content-length-range', 1, 5 * 1024 * 1024]);

    // Not uploaded yet: no download link.
    assert.equal((await call('GET', `/expenses/${expense.id}`, { user })).body.receiptUrl, undefined);

    await onReceiptUploaded(s3Event(key));
    const got = await call('GET', `/expenses/${expense.id}`, { user });
    assert.equal(got.body.receiptUploaded, true);
    assert.match(got.body.receiptUrl, /X-Amz-Signature=/);
  });

  test('S3 events for unknown or replaced keys change nothing', async () => {
    const user = newUser();
    const { body: expense } = await call('POST', '/expenses', { user, body: lunch });
    const first = (await call('POST', `/expenses/${expense.id}/receipt`, { user, body: { contentType: 'image/png' } })).body.fields.key;
    await call('POST', `/expenses/${expense.id}/receipt`, { user, body: { contentType: 'application/pdf' } }); // replaced

    await onReceiptUploaded(s3Event(first));                                 // stale upload
    await onReceiptUploaded(s3Event(`receipts/${newUser()}/${expense.id}/x.png`)); // another user's path
    await onReceiptUploaded(s3Event('somewhere/else.png'));                  // outside receipts/
    assert.equal((await call('GET', `/expenses/${expense.id}`, { user })).body.receiptUploaded, false);
  });

  test('only images and PDFs', async () => {
    const user = newUser();
    const { body: expense } = await call('POST', '/expenses', { user, body: lunch });
    const r = await call('POST', `/expenses/${expense.id}/receipt`, { user, body: { contentType: 'text/html' } });
    assert.equal(r.status, 400);
  });
});

describe('monthly summary', () => {
  test('totals per currency and category, never mixing currencies', async () => {
    const user = newUser();
    for (const e of [
      { ...lunch, amountCents: 1000 },
      { ...lunch, amountCents: 500 },
      { ...lunch, amountCents: 2000, category: 'transport' },
      { ...lunch, amountCents: 300000, currency: 'LKR' },
      { ...lunch, amountCents: 9999, date: '2026-11-01' }, // other month
    ]) {
      await call('POST', '/expenses', { user, body: e });
    }
    const r = await call('GET', '/summary', { user, query: { month: '2026-10' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      month: '2026-10',
      count: 4,
      totals: {
        SGD: { totalCents: 3500, byCategory: { food: 1500, transport: 2000 } },
        LKR: { totalCents: 300000, byCategory: { food: 300000 } },
      },
    });
  });
});
