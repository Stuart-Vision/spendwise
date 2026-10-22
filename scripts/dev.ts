// Runs the API locally: an in-memory DynamoDB (dynalite) plus a small HTTP
// server that turns requests into API Gateway events and calls the handlers.
//   npm run dev  ->  http://localhost:3000
import { createServer } from 'node:http';
import dynalite from 'dynalite';
import { createTable } from './table.js';
import { apiEvent, matchRoute } from './event.js';

const DB_PORT = 4567;
const PORT = Number(process.env.PORT ?? 3000);

process.env.DYNAMODB_ENDPOINT = `http://127.0.0.1:${DB_PORT}`;
process.env.TABLE_NAME = 'spendwise-local';
process.env.BUCKET_NAME = 'spendwise-local-receipts'; // presigning works offline; real uploads need AWS

await new Promise<void>((resolve) => dynalite({ createTableMs: 0 }).listen(DB_PORT, resolve));
await createTable(process.env.DYNAMODB_ENDPOINT, process.env.TABLE_NAME);
const { routes } = await import('./routes.js'); // after env is set

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = matchRoute(routes, req.method ?? 'GET', url.pathname);
  if (!match) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not Found"}');
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const event = apiEvent({
    method: match.route.method,
    route: match.route.path,
    path: url.pathname,
    pathParameters: Object.keys(match.params).length ? match.params : undefined,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers as Record<string, string>,
    body: body || undefined,
  });
  const result = await (match.route as (typeof routes)[number]).handler(event);
  const r = typeof result === 'string' ? { statusCode: 200, body: result, headers: {} } : result;
  res.writeHead(r.statusCode ?? 200, r.headers as Record<string, string>).end(r.body);
}).listen(PORT, () => console.log(`SpendWise API on http://localhost:${PORT}`));
