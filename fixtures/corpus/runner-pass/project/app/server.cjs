// The fixture application: a loopback-only HTTP service with two endpoints.
//
// HERMETIC BY CONSTRUCTION. It binds 127.0.0.1 and nothing else, resolves no
// hostname, opens no outbound socket, reads no environment beyond the port the
// runner substituted into the config, and touches nothing outside its own
// directory. Node built-ins only: the corpus must never need an install.
//
// SELF-LIMITING. A service is normally torn down with its process group, but a
// test run that is killed outright runs no teardown at all (Epic 4 retro, §2
// observation 8). The unref'd timer below closes the server after five minutes
// even if nothing ever signals it, so the worst case is a self-healing leak
// rather than a process that lives until the machine reboots.

const http = require('node:http');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;

const server = http.createServer((request, response) => {
  const headers = { 'content-type': 'application/json' };

  if (request.url === '/health') {
    response.writeHead(200, headers);
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (request.url === '/orders') {
    // The value E1-01 pins. Hand-written here and hand-written in expected.json,
    // independently: that is the whole point of the corpus.
    response.writeHead(200, headers);
    response.end(JSON.stringify({ orders: [], status: 'approved' }));
    return;
  }

  response.writeHead(404, headers);
  response.end('{}');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`listening on 127.0.0.1:${PORT}\n`);
});

setTimeout(() => {
  server.close();
}, MAX_LIFETIME_MS).unref();
