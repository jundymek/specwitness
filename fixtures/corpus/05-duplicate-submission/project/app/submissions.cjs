// THE DEFECT LIVES HERE, and it is a field that is never written down.
//
// The duplicate check is present, it is correct, and it can never match.
// `isDuplicate` looks for a persisted row carrying the submission's
// idempotency key; `toRow` — the function that decides what a persisted row
// CONTAINS — does not put the key in it. So the lookup misses every time and
// each re-submission appends another row.
//
// WHY NO STORY-LEVEL GATE COULD HAVE CAUGHT THIS. Neither function is wrong on
// its own, and there is nothing for a linter or a type checker to see: reading
// an absent property of a plain object is legal JavaScript and yields
// `undefined`, which is exactly what a correct "not a duplicate" answer looks
// like. The module's unit suite (`commands/module-tests.cjs`) is GREEN, because
// each function is tested against inputs the test itself constructs:
// `isDuplicate` is handed rows that carry the key, and `toRow` is checked for
// the fields it does produce. The defect is in the COMPOSITION — what one
// function writes is not what the other reads — and a unit test of either one
// cannot see it. Only repeating the action against the assembled system and
// looking at what was persisted can, which is brief section 35's example
// exactly.

/** True when the store already holds this submission. */
function isDuplicate(rows, idempotencyKey) {
  return rows.some((row) => row.idempotencyKey === idempotencyKey);
}

/**
 * The persisted shape of a submission.
 *
 * The idempotency key is deliberately absent here — this is the defect. It is
 * the sort of omission that reads as tidiness ("the key is a transport concern,
 * not part of the order") right up until it is composed with `isDuplicate`.
 */
function toRow(sequence, submission) {
  return {
    id: `order-${sequence}`,
    item: submission.item,
    quantity: submission.quantity,
    status: 'accepted',
  };
}

module.exports = { isDuplicate, toRow };
