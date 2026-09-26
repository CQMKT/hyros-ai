/**
 * An Upstash-shaped KV on localhost for tests, so api/_store.js runs its
 * real code: POST body = one command array, reply { result }. Supports
 * GET, SET (NX / EX ignored except NX), DEL (many), SCAN (MATCH glob).
 *
 *   const { server, store } = await startMockKv(4324);
 *   process.env.KV_REST_API_URL = 'http://127.0.0.1:4324'; process.env.KV_REST_API_TOKEN = 't';
 */
import { createServer } from 'node:http';

const globToRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export function kvExec(store, cmd) {
  const [op, ...args] = cmd.map(String);
  switch (op.toUpperCase()) {
    case 'GET': return store.get(args[0]) ?? null;
    case 'SET': {
      const [key, value, ...opts] = args;
      if (opts.includes('NX') && store.has(key)) return null;
      store.set(key, value); return 'OK';
    }
    case 'DEL': { let n = 0; for (const k of args) if (store.delete(k)) n += 1; return n; }
    case 'SCAN': { const m = args.indexOf('MATCH'); const re = m >= 0 ? globToRe(args[m + 1]) : /.*/; return ['0', [...store.keys()].filter((k) => re.test(k))]; }
    default: return null;
  }
}

export function startMockKv(port = 4324) {
  const store = new Map();
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      let result = null;
      try { result = kvExec(store, JSON.parse(body)); } catch { result = null; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result }));
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, store }));
  });
}
