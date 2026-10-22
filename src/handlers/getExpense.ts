// GET /expenses/{id}
import { getExpense } from '../lib/expenses.js';
import { handler, notFound, pathParam, userId } from '../lib/http.js';
import { downloadUrl } from '../lib/receipts.js';

export const main = handler(async (event) => {
  const expense = await getExpense(userId(event), pathParam(event, 'id'));
  if (!expense) throw notFound('Expense');
  const receiptUrl = expense.receiptKey && expense.receiptUploaded ? await downloadUrl(expense.receiptKey) : undefined;
  return { statusCode: 200, body: { ...expense, receiptUrl } };
});
