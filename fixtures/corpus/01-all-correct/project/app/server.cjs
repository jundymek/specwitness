// Fixture 01 — the CORRECT order service. Nothing here is wrong, on purpose.
//
// This is the fixture that proves SpecWitness does not cry wolf, and it is the
// one most likely to rot: it is the only fixture in the corpus whose
// expectation is "everything the pipeline does, end to end, comes out green".
// A change anywhere in gates, services, http, observation or shell breaks this
// one first, which is exactly what it is for.
//
// HERMETIC BY CONSTRUCTION. It binds 127.0.0.1 and nothing else, resolves no
// hostname, opens no outbound socket, reads no environment beyond the port the
// corpus runner substituted into the config, and touches nothing outside its
// own directory. Node built-ins only: the corpus must never need an install.
//
// DETERMINISTIC. Order ids are derived from the number of orders already
// stored, never from a clock or a random source, so two runs of this fixture
// produce byte-identical state and a fixture that pinned an id would still be
// honest.
//
// SELF-LIMITING. A service is normally torn down with its process group, but a
// test run that is killed outright runs no teardown at all (Epic 4 retro, §2
// observation 8). The unref'd timer below closes the server after five minutes
// even if nothing ever signals it, so the worst case is a self-healing leak
// rather than a process that lives until the machine reboots.

const http = require('node:http');

const store = require('./store.cjs');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;

/** The currency this service's frozen contract requires it to report. */
const CURRENCY = 'EUR';

/** Unit price in minor units, fixed so a total is arithmetic and not a lookup. */
const UNIT_PRICE_MINOR = 1000;

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

function parseOrderRequest(raw) {
  if (raw.trim() === '') {
    return { item: 'widget', quantity: 1 };
  }
  const parsed = JSON.parse(raw);
  return {
    item: typeof parsed.item === 'string' ? parsed.item : 'widget',
    quantity: Number.isInteger(parsed.quantity) && parsed.quantity > 0 ? parsed.quantity : 1,
  };
}

function createOrder(request) {
  const state = store.read();
  const sequence = state.orders.length + 1;
  const order = {
    id: `order-${sequence}`,
    item: request.item,
    quantity: request.quantity,
    // The value criterion E1-01 pins. Hand-written here and hand-written in
    // expected.json, independently: that is the whole point of the corpus.
    status: 'approved',
    total: (UNIT_PRICE_MINOR * request.quantity) / 100,
    currency: CURRENCY,
  };
  state.orders.push(order);
  store.write(state);
  return order;
}

const server = http.createServer((request, response) => {
  const url = request.url ?? '/';

  if (request.method === 'GET' && url === '/health') {
    send(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'GET' && url === '/orders') {
    const state = store.read();
    send(response, 200, { count: state.orders.length, orders: state.orders });
    return;
  }

  if (request.method === 'POST' && url === '/orders') {
    readBody(request)
      .then((raw) => {
        send(response, 201, createOrder(parseOrderRequest(raw)));
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
