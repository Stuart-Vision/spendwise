// POST /expenses/{id}/receipt  ->  a presigned form the client uploads the file to
import { setReceiptKey } from '../lib/expenses.js';
import { handler, jsonBody, pathParam, userId } from '../lib/http.js';
import { MAX_RECEIPT_BYTES, ReceiptRequest, receiptKey, uploadForm } from '../lib/receipts.js';

export const main = handler(async (event) => {
  const user = userId(event);
  const id = pathParam(event, 'id');
  const { contentType } = ReceiptRequest.parse(jsonBody(event));
  const key = receiptKey(user, id, contentType);
  await setReceiptKey(user, id, key); // 404 if the expense isn't this user's
  const { url, fields } = await uploadForm(key, contentType);
  return { statusCode: 200, body: { url, fields, maxBytes: MAX_RECEIPT_BYTES, expiresInSeconds: 300 } };
});
