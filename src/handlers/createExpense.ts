// POST /expenses
import { createExpense, NewExpense } from '../lib/expenses.js';
import { handler, HttpError, jsonBody, userId } from '../lib/http.js';

export const main = handler(async (event) => {
  const user = userId(event);
  const input = NewExpense.parse(jsonBody(event));
  const key = event.headers?.['idempotency-key'];
  if (key !== undefined && (key.length < 1 || key.length > 100)) {
    throw new HttpError(400, 'invalid_request', 'Idempotency-Key must be 1 to 100 characters');
  }
  const { expense, created } = await createExpense(user, input, key);
  // A retry with the same key gets the original expense back, not a duplicate.
  return { statusCode: created ? 201 : 200, body: expense, headers: created ? undefined : { 'idempotent-replayed': 'true' } };
});
