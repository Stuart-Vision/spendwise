// Triggered by S3 (ObjectCreated) when a receipt lands in the bucket: marks the
// expense's receipt as uploaded. Event-driven, so the client never has to call
// back to confirm the upload.
import type { S3Event } from 'aws-lambda';
import { markReceiptUploaded } from '../lib/expenses.js';

export async function main(event: S3Event): Promise<void> {
  for (const record of event.Records) {
    // S3 URL-encodes keys in events, with "+" for spaces.
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const updated = await markReceiptUploaded(key);
    console.log(JSON.stringify({ level: 'info', msg: 'receipt uploaded', key, updated }));
  }
}
