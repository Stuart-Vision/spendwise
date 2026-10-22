// Builds API Gateway HTTP API (payload format 2.0) events, the same shape AWS
// passes to Lambda. Used by the local server and the tests.
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export interface Route {
  method: string;
  path: string; // e.g. /expenses/{id}
}

export function matchRoute(routes: Route[], method: string, rawPath: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const pattern = new RegExp('^' + route.path.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    const m = pattern.exec(rawPath);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return undefined;
}

export function apiEvent(opts: {
  method: string;
  route: string;
  path: string;
  pathParameters?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}): APIGatewayProxyEventV2 {
  const query = opts.query ?? {};
  const rawQueryString = new URLSearchParams(query).toString();
  return {
    version: '2.0',
    routeKey: `${opts.method} ${opts.route}`,
    rawPath: opts.path,
    rawQueryString,
    headers: Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    queryStringParameters: rawQueryString ? query : undefined,
    pathParameters: opts.pathParameters,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    isBase64Encoded: false,
    requestContext: {
      accountId: 'local', apiId: 'local', domainName: 'localhost', domainPrefix: 'localhost',
      http: { method: opts.method, path: opts.path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'local' },
      requestId: randomUUID(), routeKey: `${opts.method} ${opts.route}`, stage: '$default',
      time: new Date().toISOString(), timeEpoch: Date.now(),
    },
  };
}
