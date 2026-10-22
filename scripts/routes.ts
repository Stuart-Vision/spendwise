// The API's routes, mirroring the HttpApi events in template.yaml.
import { main as createExpense } from '../src/handlers/createExpense.js';
import { main as listExpenses } from '../src/handlers/listExpenses.js';
import { main as getExpense } from '../src/handlers/getExpense.js';
import { main as deleteExpense } from '../src/handlers/deleteExpense.js';
import { main as requestReceiptUpload } from '../src/handlers/requestReceiptUpload.js';
import { main as summary } from '../src/handlers/summary.js';

export const routes = [
  { method: 'POST', path: '/expenses', handler: createExpense },
  { method: 'GET', path: '/expenses', handler: listExpenses },
  { method: 'GET', path: '/expenses/{id}', handler: getExpense },
  { method: 'DELETE', path: '/expenses/{id}', handler: deleteExpense },
  { method: 'POST', path: '/expenses/{id}/receipt', handler: requestReceiptUpload },
  { method: 'GET', path: '/summary', handler: summary },
];
