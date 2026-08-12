// Minimal node:http <-> Fetch (Request/Response) bridge for hono's app.fetch.
//
// Why this exists: hono's core is transport-agnostic (`app.fetch(request)`
// takes/returns standard Fetch API objects), but something has to translate
// node:http's IncomingMessage/ServerResponse to and from that. The usual
// answer is @hono/node-server, which is NOT installed here (no new deps
// allowed for Phase 1) — Node 24 already ships everything this needs:
// global Request/Response/Headers and stream.Readable.toWeb/fromWeb.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';

function toFetchRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? '127.0.0.1';
  const url = `http://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.append(key, value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as ReadableStream;
    (init as { duplex?: 'half' }).duplex = 'half'; // required by undici when body is a stream
  }
  return new Request(url, init);
}

async function sendFetchResponse(res: ServerResponse, fres: Response): Promise<void> {
  res.statusCode = fres.status;
  fres.headers.forEach((value, key) => res.setHeader(key, value));
  if (!fres.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const nodeReadable = Readable.fromWeb(fres.body as NonNullable<typeof fres.body>);
    nodeReadable.on('error', reject);
    res.on('error', reject);
    res.on('finish', () => resolve());
    nodeReadable.pipe(res);
  });
}

export function serveHono(app: Hono, port: number, hostname: string): Server {
  const server = createServer((req, res) => {
    Promise.resolve(toFetchRequest(req))
      .then((freq) => app.fetch(freq))
      .then((fres) => sendFetchResponse(res, fres))
      .catch((err: unknown) => {
        console.error('admin server error:', err);
        if (!res.headersSent) res.statusCode = 500;
        res.end('internal error');
      });
  });
  server.listen(port, hostname);
  return server;
}
