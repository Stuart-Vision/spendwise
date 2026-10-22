// Receipt files live in a private S3 bucket. The browser uploads directly to S3
// with a short-lived presigned POST, so file bytes never pass through Lambda or
// API Gateway (which caps request bodies). Downloads use presigned GET URLs.
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { env, s3 } from './aws.js';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;

export const ReceiptRequest = z.object({
  contentType: z.enum(Object.keys(EXTENSIONS) as [keyof typeof EXTENSIONS, ...(keyof typeof EXTENSIONS)[]]),
}).strict();

export const receiptKey = (userId: string, expenseId: string, contentType: keyof typeof EXTENSIONS) =>
  `receipts/${userId}/${expenseId}/${randomUUID()}.${EXTENSIONS[contentType]}`;

/** A form the client POSTs the file to. S3 itself enforces the size and type limits. */
export async function uploadForm(key: string, contentType: string) {
  return createPresignedPost(s3(), {
    Bucket: env('BUCKET_NAME'),
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_RECEIPT_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: 300, // seconds
  });
}

export const downloadUrl = (key: string) =>
  getSignedUrl(s3(), new GetObjectCommand({ Bucket: env('BUCKET_NAME'), Key: key }), { expiresIn: 300 });

export const deleteReceipt = (key: string) =>
  s3().send(new DeleteObjectCommand({ Bucket: env('BUCKET_NAME'), Key: key }));
