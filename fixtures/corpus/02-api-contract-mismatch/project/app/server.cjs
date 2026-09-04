// Fixture 02 — an order service whose API contract is incomplete.
//
// The service works. It answers, it answers quickly, it answers 201, and the
// order it creates is correct. What it does not do is return the field its
// frozen contract requires — see `app/order-response.cjs`, where the single
// defect lives.
//
// HERMETIC BY CONSTRUCTION: binds 127.0.0.1 only, resolves no hostname, opens
// no outbound socket, reads no environment beyond the port the corpus runner
// substituted into the config, touches nothing outside its own directory. Node
// built-ins only.
//
// DETERMINISTIC: order ids come from a counter, never from a clock or a random
// source.
//
// SELF-LIMITING: the unref'd timer closes the server after five minutes even if
// nothing ever signals it. A test run that is killed outright runs no teardown
// at all (Epic 4 retro §2 observation 8), and a fixture that leaks a server
// breaks the next developer's machine.

const http = require('node:http');

const { serialize } = require('./order-response.cjs');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;
const UNIT_PRICE_MINOR = 1000;

let created = 0;

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

function createOrder(raw) {
  let quantity = 1;
  let item = 'widget';
  if (raw.trim() !== '') {
    const parsed = JSON.parse(raw);
    if (typeof parsed.item === 'string') {
      item = parsed.item;
    }
    if (Number.isInteger(parsed.quantity) && parsed.quantity > 0) {
      quantity = parsed.quantity;
    }
  }
  created += 1;
  return {
    id: `order-${created}`,
    item,
    quantity,
    status: 'approved',
    total: (UNIT_PRICE_MINOR * quantity) / 100,
    currency: 'EUR',
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
        // The order is correct. What crosses the wire is `serialize(order)`,
        // and that is where the contract is broken.
        send(response, 201, serialize(createOrder(raw)));
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
