// STORY B's module: fulfilment. It is CORRECT, and its own test suite passes.
//
// Its vocabulary is the IMPERATIVE — the transition table is keyed by the
// COMMAND being issued, `approve` or `decline`, not by the state something
// ended in. That is also a perfectly ordinary choice for a state machine, it is
// used consistently throughout this module, and it is documented right here.
//
// AN UNRECOGNISED COMMAND LEAVES THE ORDER WHERE IT WAS, and that is correct
// behaviour, deliberately: a state machine that guessed at a command it did not
// know would be a worse module than this one. It is the SAFE answer, which is
// exactly why the resulting defect is silent.
//
// Nothing in this file is a defect either. The defect exists only where these
// two modules meet — see `app/server.cjs`.

/** The commands this machine accepts. Imperative, throughout. */
const COMMANDS = Object.freeze({
  APPROVE: 'approve',
  DECLINE: 'decline',
});

const TRANSITIONS = Object.freeze({
  [COMMANDS.APPROVE]: 'fulfilled',
  [COMMANDS.DECLINE]: 'cancelled',
});

/**
 * Applies a command to an order and returns its new state.
 *
 * A command this machine does not recognise leaves the state untouched. Pure:
 * no clock, no randomness, no I/O.
 */
function advance(order, command) {
  const next = TRANSITIONS[command];
  return next === undefined ? order.state : next;
}

module.exports = { advance, COMMANDS, TRANSITIONS };
