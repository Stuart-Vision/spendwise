// Expense data access: a single DynamoDB table.
//
//   pk = USER#<userId>     sk = EXP#<expenseId>       one item per expense
//   LSI "byDate":          pk + date (YYYY-MM-DD)     list a user's expenses for a month
//
// Every query is scoped to one user's partition, so a user can never read or
// change another user's data. The LSI (unlike a GSI) supports strongly
// consistent reads, so an expense shows up in the list as soon as it is created.
import { createHash, randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { dynamo, env } from './aws.js';
import { notFound } from './http.js';

export const CATEGORIES = ['food', 'transport', 'housing', 'utilities', 'shopping', 'health', 'entertainment', 'other'] as const;
export const CURRENCIES = ['SGD', 'USD', 'AED', 'LKR'] as const;

export const NewExpense = z.object({
  amountCents: z.number().int().positive().max(100_000_000),
  currency: z.enum(CURRENCIES),
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine(isRealDate, 'is not a real date'),
}).strict();
export type NewExpense = z.infer<typeof NewExpense>;

export const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');

export interface Expense extends NewExpense {
  id: string;
  createdAt: string;
  receiptKey?: string;
  receiptUploaded?: boolean;
}

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

const table = () => env('TABLE_NAME');
const pk = (userId: string) => `USER#${userId}`;
const sk = (id: string) => `EXP#${id}`;

function toExpense(item: Record<string, unknown>): Expense {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as unknown as Expense;
}

/**
 * Turns an idempotency key into a stable expense id, so a retried request
 * writes the same item instead of creating a duplicate.
 */
function idFromKey(userId: string, key: string): string {
  const h = createHash('sha256').update(`${userId}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Creates an expense. Returns `created: false` when an earlier request with the same key already did. */
export async function createExpense(userId: string, input: NewExpense, idempotencyKey?: string): Promise<{ expense: Expense; created: boolean }> {
  const expense: Expense = {
    ...input,
    id: idempotencyKey ? idFromKey(userId, idempotencyKey) : randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    await dynamo().send(new PutCommand({
      TableName: table(),
      Item: { pk: pk(userId), sk: sk(expense.id), ...expense },
      ConditionExpression: 'attribute_not_exists(pk)', // never overwrite
    }));
    return { expense, created: true };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException && idempotencyKey) {
      const existing = await getExpense(userId, expense.id);
      if (existing) return { expense: existing, created: false };
    }
    throw err;
  }
}

export async function getExpense(userId: string, id: string): Promise<Expense | undefined> {
  const { Item } = await dynamo().send(new GetCommand({ TableName: table(), Key: { pk: pk(userId), sk: sk(id) } }));
  return Item && toExpense(Item);
}

/** All of a user's expenses in one month, newest first. Follows pagination. */
export async function listExpenses(userId: string, month: string): Promise<Expense[]> {
  const items: Expense[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamo().send(new QueryCommand({
      TableName: table(),
      IndexName: 'byDate',
      KeyConditionExpression: 'pk = :pk AND begins_with(#date, :month)',
      ExpressionAttributeNames: { '#date': 'date' }, // "date" is a DynamoDB reserved word
      ExpressionAttributeValues: { ':pk': pk(userId), ':month': `${month}-` },
      ScanIndexForward: false,
      ConsistentRead: true,
      ExclusiveStartKey: startKey,
    }));
    items.push(...(page.Items ?? []).map(toExpense));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** Deletes an expense and returns it (so the caller can clean up its receipt). */
export async function deleteExpense(userId: string, id: string): Promise<Expense> {
  try {
    const { Attributes } = await dynamo().send(new DeleteCommand({
      TableName: table(),
      Key: { pk: pk(userId), sk: sk(id) },
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'ALL_OLD',
    }));
    return toExpense(Attributes!);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw notFound('Expense');
    throw err;
  }
}

/** Records where the receipt will be uploaded. Fails with 404 if the expense doesn't exist. */
export async function setReceiptKey(userId: string, id: string, key: string): Promise<void> {
  try {
    await dynamo().send(new UpdateCommand({
      TableName: table(),
      Key: { pk: pk(userId), sk: sk(id) },
      UpdateExpression: 'SET receiptKey = :key, receiptUploaded = :false',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':key': key, ':false': false },
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw notFound('Expense');
    throw err;
  }
}

/**
 * Marks a receipt as uploaded. Called from the S3 event, so it only trusts the
 * object key: receipts/<userId>/<expenseId>/<file>. Ignores keys that no
 * longer match the expense (e.g. the receipt was replaced or the expense deleted).
 */
export async function markReceiptUploaded(key: string): Promise<boolean> {
  const match = /^receipts\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/[^/]+$/.exec(key);
  if (!match) return false;
  const [, userId, id] = match;
  try {
    await dynamo().send(new UpdateCommand({
      TableName: table(),
      Key: { pk: pk(userId), sk: sk(id) },
      UpdateExpression: 'SET receiptUploaded = :true',
      ConditionExpression: 'receiptKey = :key',
      ExpressionAttributeValues: { ':true': true, ':key': key },
    }));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export interface Summary {
  month: string;
  count: number;
  /** Totals per currency, then per category, in cents. Currencies are never mixed. */
  totals: Record<string, { totalCents: number; byCategory: Record<string, number> }>;
}

export function summarise(month: string, expenses: Expense[]): Summary {
  const totals: Summary['totals'] = {};
  for (const e of expenses) {
    const t = (totals[e.currency] ??= { totalCents: 0, byCategory: {} });
    t.totalCents += e.amountCents;
    t.byCategory[e.category] = (t.byCategory[e.category] ?? 0) + e.amountCents;
  }
  return { month, count: expenses.length, totals };
}
