// The fixture application: a loopback-only HTTP service.
//
// HERMETIC BY CONSTRUCTION. It binds 127.0.0.1 and nothing else, resolves no
// hostname, opens no outbound socket and touches nothing outside its own
// directory. Node built-ins only.
//
// It puts the project-shaped secret in a RESPONSE HEADER and in the BODY, both
// of which the http surface captures. Neither is what E1-01 asserts on.
//
// SELF-LIMITING: the unref'd timer closes the server after five minutes even if
// nothing ever signals it, so a killed test run leaks nothing for long.

const http = require('node:http');

const PORT = Number(process.argv[2]);
const MAX_LIFETIME_MS = 300_000;
const HANDLE = 'wombat-7x3k9q2m4p';

const server = http.createServer((request, response) => {
  const headers = { 'content-type': 'application/json', 'x-release-handle': HANDLE };

  if (request.url === '/health') {
    response.writeHead(200, headers);
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (request.url === '/release') {
    response.writeHead(200, headers);
    response.end(JSON.stringify({ state: 'published', handle: HANDLE }));
    return;
  }

  response.writeHead(404, headers);
  response.end('{}');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`listening on ${PORT}\n`);
});

setTimeout(() => server.close(), MAX_LIFETIME_MS).unref();
