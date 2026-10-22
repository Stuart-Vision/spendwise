// DELETE /expenses/{id}
import { deleteExpense } from '../lib/expenses.js';
import { handler, pathParam, userId } from '../lib/http.js';
import { deleteReceipt } from '../lib/receipts.js';

export const main = handler(async (event) => {
  const expense = await deleteExpense(userId(event), pathParam(event, 'id'));
  if (expense.receiptKey) {
    // Best effort: the expense is already gone, so a leftover file is only a cost
    // issue (the bucket's lifecycle rule would also be a place to sweep these).
    await deleteReceipt(expense.receiptKey).catch((err) =>
      console.error(JSON.stringify({ level: 'error', msg: 'receipt delete failed', key: expense.receiptKey, error: String(err) })));
  }
  return { statusCode: 204 };
});
