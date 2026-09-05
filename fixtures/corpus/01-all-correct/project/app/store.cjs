// The fixture's "database": one JSON file under `store/`, read and written on
// every call.
//
// A FILE RATHER THAN A PROCESS VARIABLE, because the observation surface is the
// point of this corpus. An observation command is a SEPARATE PROCESS that the
// project owner declares in config (`src/surfaces/observation.ts` — stack
// neutrality: SpecWitness names no database), so persisted state a probe can
// see has to be reachable from outside the service. In-memory state would make
// the observation probes unable to observe anything at all.
//
// READ ON EVERY CALL, never cached. The verification pipeline starts services
// BEFORE the data stage (`src/pipeline/stages/index.ts:153-154`), so a service
// that snapshotted the store at boot would be answering from a state that a
// later stage could have changed underneath it. Reading each time removes the
// question rather than making it a fixture author's problem.
//
// Hermetic: `node:fs` and a path derived from this file's own location. No
// clock, no network, no environment, nothing outside this directory.

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const STORE = join(__dirname, '..', 'store', 'orders.json');

function read() {
  return JSON.parse(readFileSync(STORE, 'utf8'));
}

function write(state) {
  writeFileSync(STORE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

module.exports = { read, write, STORE };
