// Shared HTTP plumbing for Lambda handlers behind an API Gateway HTTP API (payload v2).
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';

/** An HTTP API event, optionally carrying JWT authorizer claims (when a Cognito authorizer is attached). */
export type Event = Omit<APIGatewayProxyEventV2, 'requestContext'> & {
  requestContext: APIGatewayProxyEventV2['requestContext'] & { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
};
export type Result = { statusCode: number; body?: unknown; headers?: Record<string, string> };

/** An error that becomes an HTTP response with a stable error code. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

/**
 * Wraps a handler: parses nothing itself, but turns thrown errors into JSON
 * responses and writes one structured log line per request (CloudWatch Logs
 * can then be queried with Logs Insights).
 */
export function handler(fn: (event: Event) => Promise<Result>) {
  return async (event: Event): Promise<APIGatewayProxyResultV2> => {
    const started = Date.now();
    let result: Result;
    try {
      result = await fn(event);
    } catch (err) {
      result = toErrorResult(err);
      if (result.statusCode >= 500) {
        console.error(JSON.stringify({ level: 'error', requestId: event.requestContext?.requestId, error: String(err), stack: (err as Error)?.stack }));
      }
    }
    console.log(JSON.stringify({
      level: 'info',
      requestId: event.requestContext?.requestId,
      route: event.routeKey,
      status: result.statusCode,
      ms: Date.now() - started,
    }));
    return {
      statusCode: result.statusCode,
      headers: { 'content-type': 'application/json', ...result.headers },
      body: result.body === undefined ? '' : JSON.stringify(result.body),
    };
  };
}

function toErrorResult(err: unknown): Result {
  if (err instanceof HttpError) {
    return { statusCode: err.status, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return { statusCode: 400, body: { error: { code: 'invalid_request', message } } };
  }
  return { statusCode: 500, body: { error: { code: 'internal', message: 'Something went wrong' } } };
}

/** Parses the JSON body, or throws a 400. */
export function jsonBody(event: Event): unknown {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller's user id. In production the API uses a Cognito JWT authorizer and
 * the id is the token's `sub` claim. Without an authorizer (the demo and local
 * runs) the client sends an anonymous id in the X-User-Id header instead.
 */
export function userId(event: Event): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub === 'string' && sub) return sub;
  const header = event.headers?.['x-user-id'];
  if (header && UUID.test(header)) return header.toLowerCase();
  throw new HttpError(401, 'unauthenticated', 'Send a valid X-User-Id header (a UUID)');
}

export function pathParam(event: Event, name: string): string {
  const value = event.pathParameters?.[name];
  if (!value || !UUID.test(value)) throw notFound('Expense');
  return value.toLowerCase();
}
