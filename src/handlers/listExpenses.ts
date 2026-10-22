// GET /expenses?month=YYYY-MM
import { listExpenses, Month } from '../lib/expenses.js';
import { handler, userId } from '../lib/http.js';

export const main = handler(async (event) => {
  const user = userId(event);
  const month = Month.parse(event.queryStringParameters?.month ?? new Date().toISOString().slice(0, 7));
  return { statusCode: 200, body: { month, expenses: await listExpenses(user, month) } };
});
