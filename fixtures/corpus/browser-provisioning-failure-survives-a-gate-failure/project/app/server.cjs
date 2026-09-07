// Fixture `browser-probe-provisions` — the smallest page a browser probe could look at.
//
// ⚠️ IT IS NOT THE SUBJECT OF THIS FIXTURE, and on a correct product it never starts. The
// fixture is decided BEFORE the services stage: `verify` provisions Playwright when the
// compiled plan carries a browser probe (story 7.0), the corpus shadows `npm` with a
// tripwire that fetches nothing, and the run therefore stops at exit 3 with the environment
// it could not build. The page exists so the plan's `serviceId` names something real and so
// the fixture would still fail for its stated reason rather than for a missing file.
//
// HERMETIC BY CONSTRUCTION: binds 127.0.0.1 only, resolves no hostname, opens no outbound
// socket, reads nothing outside its own directory, Node built-ins only.
//
// SELF-LIMITING: the unref'd timer closes the server after five minutes even if nothing
// signals it. A test run that is killed outright runs no teardown at all (Epic 4 retro §2
// observation 8), and a fixture that leaks a server breaks the next developer's machine.

const http = require('node:http');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>Orders</title></head><body><h1 id="heading">Orders</h1>' +
  '<p id="count">3 orders</p></body></html>';

const server = http.createServer((request, response) => {
  const url = request.url ?? '/';

  if (request.method === 'GET' && url === '/health') {
    const body = JSON.stringify({ status: 'ok' });
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }

  if (request.method === 'GET' && url === '/') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(PAGE),
    });
    response.end(PAGE);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`listening on 127.0.0.1:${PORT}\n`);
});

setTimeout(() => {
  server.close();
}, MAX_LIFETIME_MS).unref();
