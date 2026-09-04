// Fixture 10 — THE SEAM. Two individually correct modules, assembled wrongly.
//
// Read `modules/checkout/index.cjs` and `modules/fulfilment/index.cjs` first.
// Each is correct. Each has a passing test suite. Neither contains a defect.
//
// THE DEFECT IS THIS LINE, and it is not visible in either module:
//
//     fulfilment.advance(order, decision.decision)
//
// `decision.decision` is checkout's vocabulary — `"approved"`. `advance`
// expects fulfilment's — `"approve"`. The transition table has no entry for
// `"approved"`, so the state machine correctly refuses to guess and leaves the
// order `pending`. Every part behaves as designed and the system does the wrong
// thing.
//
// WHAT THE RESPONSE SAYS. 200, with checkout's decision, which is TRUE about
// checkout. The handler is reporting the half of the transaction it owns. That
// is why no http probe can find this, and why the fixture's failing criterion
// has to be an observation of what was persisted.
//
// HERMETIC: binds 127.0.0.1 only, no hostname resolution, no outbound socket,
// no environment beyond the substituted port, nothing outside this directory.
//
// DETERMINISTIC: ids come from the number of stored rows; the cart is fixed.
//
// SELF-LIMITING: the unref'd timer closes the server after five minutes even if
// nothing signals it (Epic 4 retro §2 observation 8).

const http = require('node:http');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const checkout = require('../modules/checkout/index.cjs');
const fulfilment = require('../modules/fulfilment/index.cjs');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;
const STORE = join(__dirname, '..', 'store', 'orders.json');

/** A fixed cart, so the decision is the same on every run. */
const CART = { items: [{ priceMinor: 1000, quantity: 2 }] };

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = request.url ?? '/';

  if (request.method === 'GET' && url === '/health') {
    send(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'POST' && url === '/checkout') {
    const state = JSON.parse(readFileSync(STORE, 'utf8'));
    const decision = checkout.decide(CART);
    const order = { id: `order-${state.orders.length + 1}`, state: 'pending' };

    // ⚠️ THE SEAM. checkout says `approved`; fulfilment listens for `approve`.
    order.state = fulfilment.advance(order, decision.decision);

    state.orders.push(order);
    writeFileSync(STORE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    send(response, 200, {
      ok: true,
      orderId: order.id,
      totalMinor: decision.totalMinor,
      decision: decision.decision,
    });
    return;
  }

  send(response, 404, { ok: false, message: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`listening on 127.0.0.1:${PORT}\n`);
});

setTimeout(() => {
  server.close();
}, MAX_LIFETIME_MS).unref();
