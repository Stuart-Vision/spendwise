// AWS SDK clients, created once per Lambda container and reused across invocations.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Local runs and tests point the SDK at an in-memory DynamoDB (dynalite).
const local = process.env.DYNAMODB_ENDPOINT
  ? { endpoint: process.env.DYNAMODB_ENDPOINT, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
  : {};

let doc: DynamoDBDocumentClient | undefined;
export function dynamo(): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient(local), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return doc;
}

let s3Client: S3Client | undefined;
export function s3(): S3Client {
  s3Client ??= new S3Client(
    process.env.DYNAMODB_ENDPOINT
      ? { region: 'ap-southeast-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {},
  );
  return s3Client;
}
