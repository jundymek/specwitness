// Fixture 03 — the UI reports success and the persisted state never changed.
//
// Everything a response-level check can see is correct: the endpoint exists, it
// answers 200, and the message it returns is the one a person would be shown.
// The defect is in `app/confirmations.cjs`, which never writes the confirmation
// to `store/orders.json`.
//
// THE FIXTURE MUST FAIL ON THE OBSERVATION, NOT ON THE UI. That is why the
// confirm endpoint here is deliberately, fully correct: criterion E3-01 probes
// it and must PASS. A fixture whose http probe went red would be testing a
// broken endpoint, which is a defect class every story-level test already
// catches, and would prove nothing about epic-level verification.
//
// HERMETIC: binds 127.0.0.1 only, no hostname resolution, no outbound socket,
// no environment beyond the substituted port, nothing outside this directory.
// Node built-ins only.
//
// SELF-LIMITING: the unref'd timer closes the server after five minutes even if
// nothing signals it (Epic 4 retro §2 observation 8).

const http = require('node:http');

const confirmations = require('./confirmations.cjs');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;

const CONFIRM = /^\/orders\/([A-Za-z0-9-]+)\/confirm$/;

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

  const confirm = request.method === 'POST' ? CONFIRM.exec(url) : null;
  if (confirm !== null) {
    const receipt = confirmations.record(confirm[1]);
    if (receipt === undefined) {
      send(response, 404, { ok: false, message: 'No such order' });
      return;
    }
    // The success a person sees. It is not a lie about what this handler did —
    // it is a lie about what the SYSTEM did, and only the system can be asked.
    send(response, 200, {
      ok: true,
      message: `Order ${receipt.orderId} confirmed`,
      state: receipt.state,
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
