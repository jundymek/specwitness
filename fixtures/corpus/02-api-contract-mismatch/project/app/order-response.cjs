// THE DEFECT LIVES HERE, and it is one missing key.
//
// The frozen contract requires the order-creation response to carry the
// currency (criterion E2-01). This serializer does not emit it. Everything else
// about the response is right: the status code is 201, the order is genuinely
// approved, the total is correct, and the endpoint reports success.
//
// WHY NO STORY-LEVEL GATE COULD HAVE CAUGHT THIS. There is nothing here for a
// linter or a type checker to see: this is a plain JavaScript object literal,
// every key it names exists and every value is the right type. And the module's
// own unit suite (`gates/tests.cjs`) is GREEN, because it was written from this
// implementation — it asserts that `serialize` round-trips the fields it
// produces, which it does, perfectly. A test written from the code can never
// notice a field the code never had. Only something holding the FROZEN CONTRACT
// beside the running system can, which is the whole claim of brief section 7.

const PRESENTATION_CURRENCY = 'EUR';

/**
 * The order as the API returns it.
 *
 * `currency` is absent: the client is expected to know it. That expectation is
 * exactly what the contract forbids, and exactly what no consumer of this
 * module can see.
 */
function serialize(order) {
  return {
    id: order.id,
    item: order.item,
    quantity: order.quantity,
    status: order.status,
    total: order.total,
  };
}

/** What the UI puts in front of a person, having assumed the currency. */
function present(order) {
  return `${order.total.toFixed(2)} ${PRESENTATION_CURRENCY}`;
}

module.exports = { serialize, present, PRESENTATION_CURRENCY };
