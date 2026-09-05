#!/usr/bin/env python3
# The fixture application: a loopback-only HTTP inventory service.
#
# ===========================================================================
# THIS IS THE FIRST SOURCE FILE IN THIS REPOSITORY THAT IS NOT TYPESCRIPT.
# ===========================================================================
# It is Python ON PURPOSE and it must stay Python. Story 6.4 exists to test
# FR-4 -- "all stack specifics enter only through Project Config" -- which
# five epics have asserted and nothing has ever exercised, because every
# fixture, test project and integration test in this repository has been a
# Node project. A Node assumption anywhere in gate resolution, service
# startup or observation would have run green in every one of them.
#
# So: do NOT "tidy" this into the Node toolchain, do NOT add a package.json
# beside it, and do NOT rewrite it in TypeScript to match its neighbours.
# Any of those silently converts a falsifiable claim back into an
# unfalsifiable one. `tests/unit/corpus/no-package-json-in-non-node-fixture.test.ts`
# fails if a package.json appears here, and that test is the point.
#
# HERMETIC BY CONSTRUCTION. Binds 127.0.0.1 and nothing else, resolves no
# hostname, opens no outbound socket, reads no environment at all, and writes
# only the one state file named on its command line. STANDARD LIBRARY ONLY --
# every import below ships with CPython, so the corpus never needs a package
# download of any kind. Story 6.1's fixture scan enforces that independently:
# it refuses any fixture naming a tool whose purpose is to fetch, anywhere in
# any file. (The first draft of this comment named one, as prose, and the
# scan refused the fixture. That is the scan working: it reads every line
# rather than only the ones that look like declared commands, because a YAML
# block scalar or a heredoc would hide a real invocation from a narrower
# filter. The comment was reworded; the scan was not touched.)
#
# ASCII ONLY on stdout. 6.1's runner drives the CLI with `extendEnv: false`
# and sets no LANG, so under a POSIX locale Python's stdout encoding is not
# something to depend on. `json.dumps` defaults to ensure_ascii=True and
# every literal here is ASCII, which removes the question instead of
# answering it.
#
# SELF-LIMITING. A service is normally torn down with its process group, but
# a test run that is killed outright runs no teardown at all (Epic 4 retro,
# section 2 observation 8). This process is not a Node child, so it must not
# depend on being reaped by luck: the daemon watchdog below exits it after
# five minutes even if nothing ever signals it. Worst case is a self-healing
# leak rather than a process that lives until the machine reboots. The same
# reasoning, and the same five minutes, as the unref'd timer in
# fixtures/corpus/runner-pass/project/app/server.cjs.

import json
import os
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_LIFETIME_SECONDS = 300

PORT = int(sys.argv[1])
STATE_PATH = sys.argv[2]

# The seeded stock E1-01 pins. Hand-written here and hand-written again in
# expected.json, independently -- that is the whole point of the corpus.
ITEMS = [
    {"id": "widget", "stock": 3},
    {"id": "sprocket", "stock": 5},
]


def reservation_count():
    """How many reservations have been recorded so far."""
    try:
        with open(STATE_PATH, "r", encoding="ascii") as handle:
            return sum(1 for line in handle if line.strip())
    except FileNotFoundError:
        # No reservations yet. NOT an error: the before-snapshot legitimately
        # runs before anything has been reserved.
        return 0


class Handler(BaseHTTPRequestHandler):
    def _respond(self, status, payload):
        body = json.dumps(payload).encode("ascii")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok"})
            return
        if self.path == "/items":
            self._respond(200, {"items": ITEMS, "count": len(ITEMS)})
            return
        self._respond(404, {})

    def do_POST(self):
        if self.path != "/reserve":
            self._respond(404, {})
            return

        # The ACTION the observation probe wraps. It changes persisted state,
        # which is the thing an http response-level check cannot see and the
        # observation surface exists to measure (brief section 35).
        directory = os.path.dirname(STATE_PATH)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(STATE_PATH, "a", encoding="ascii") as handle:
            handle.write("widget\n")

        self._respond(201, {"reserved": "widget", "reservations": reservation_count()})

    def log_message(self, *args):
        # Silence the default stderr access log. The run's evidence records
        # what the probes observed; a request log adds noise to every run
        # directory and pins nothing.
        return


def watchdog():
    time.sleep(MAX_LIFETIME_SECONDS)
    os._exit(0)


class LoopbackHTTPServer(HTTPServer):
    """An HTTPServer that binds WITHOUT doing a reverse-DNS lookup.

    ⚠️ THIS OVERRIDE IS LOAD-BEARING, NOT TIDYING, AND IT IS THE ONE THING
    ABOUT THIS FIXTURE THAT WOULD SURPRISE ITS NEXT READER.

    `http.server.HTTPServer.server_bind` calls `socket.getfqdn(host)` purely to
    populate `self.server_name`, which nothing here uses. `getfqdn` is a
    REVERSE-DNS LOOKUP: it is a network operation, performed before the socket
    is ready to serve, and its latency is a property of the machine's resolver
    rather than of this program.

    Measured on the authoring machine rather than reasoned about:
    `socket.getfqdn('127.0.0.1')` took **35 seconds** to return 'localhost'.
    The service therefore never began serving inside the 30-second readiness
    budget, and the run failed with "service 'inventory' did not become ready"
    -- a fixture that never started, diagnosed correctly by SpecWitness as an
    infrastructure error rather than as a failing build.

    Two reasons the fix belongs here and not in the readiness timeout:

     1. **Hermeticity.** Story 6.1 AC1 permits loopback and nothing else. A
        resolver query leaves the machine, so a fixture that performs one is
        not hermetic even when it succeeds. Raising `ready.timeoutSec` would
        have made the symptom disappear while leaving a DNS lookup in the
        corpus -- green, slow, and wrong.
     2. **Determinism.** The lookup's duration depends on whatever resolver
        the runner has. On a machine that answers instantly the fixture would
        pass; on one that does not it would fail. That is precisely the
        "fails on Tuesday" fixture the corpus format is shaped against.

    `socketserver.TCPServer.server_bind` is the parent implementation -- it
    binds and nothing more -- so this skips the lookup rather than caching or
    shortening it. `server_name` and `server_port` are then set to the literal
    loopback values, which is what the skipped code would have computed.
    """

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


server = LoopbackHTTPServer(("127.0.0.1", PORT), Handler)

threading.Thread(target=watchdog, daemon=True).start()

sys.stdout.write("listening on 127.0.0.1:%d\n" % PORT)
sys.stdout.flush()

server.serve_forever()
