// Fixture 05 — a repeated submission creates duplicate rows.
//
// THE SECOND REQUEST IS THE ONE THAT REVEALS THE DEFECT, and the fixture is
// built so that nothing else can. The first submission is entirely correct and
// criterion E5-01 pins it as PASS. The second, carrying the same idempotency
// key, is ALSO answered successfully — which is the whole problem: every
// response-level check stays green while a second row appears in the store.
// Brief §35: "a duplicate submission returns 200 twice, so every response-level
// check is green, and two rows exist where one should".
//
// The defect itself is in `app/submissions.cjs`, not here: this handler asks
// the duplicate question correctly and is told the truthful answer to the wrong
// question.
//
// HERMETIC: binds 127.0.0.1 only, no hostname resolution, no outbound socket,
// no environment beyond the substituted port, nothing outside this directory.
//
// DETERMINISTIC: the row id is derived from the number of rows already stored,
// so two runs of this fixture produce identical state and `["order-1"]` versus
// `["order-1","order-2"]` is a stable, meaningful difference to assert on.
//
// SELF-LIMITING: the unref'd timer closes the server after five minutes even if
// nothing signals it (Epic 4 retro §2 observation 8).

const http = require('node:http');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const { isDuplicate, toRow } = require('./submissions.cjs');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;
const STORE = join(__dirname, '..', 'store', 'orders.json');

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function parseSubmission(raw) {
  if (raw.trim() === '') {
    return { item: 'widget', quantity: 1 };
  }
  const parsed = JSON.parse(raw);
  return {
    item: typeof parsed.item === 'string' ? parsed.item : 'widget',
    quantity: Number.isInteger(parsed.quantity) && parsed.quantity > 0 ? parsed.quantity : 1,
  };
}

const server = http.createServer((request, response) => {
  const url = request.url ?? '/';

  if (request.method === 'GET' && url === '/health') {
    send(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'POST' && url === '/orders') {
    readBody(request)
      .then((raw) => {
        const key = String(request.headers['idempotency-key'] ?? '');
        const state = JSON.parse(readFileSync(STORE, 'utf8'));

        // The question is asked. The answer is always "no", because no
        // persisted row ever carries the key — see `toRow`.
        if (isDuplicate(state.orders, key)) {
          const existing = state.orders.find((row) => row.idempotencyKey === key);
          send(response, 200, { id: existing.id, status: 'accepted', duplicate: true });
          return;
        }

        const row = toRow(state.orders.length + 1, parseSubmission(raw));
        state.orders.push(row);
        writeFileSync(STORE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        send(response, 201, { id: row.id, status: row.status, duplicate: false });
      })
      .catch((cause) => {
        send(response, 400, { error: String(cause && cause.message) });
      });
    return;
  }

  send(response, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`listening on 127.0.0.1:${PORT}\n`);
});

setTimeout(() => {
  server.close();
}, MAX_LIFETIME_MS).unref();
