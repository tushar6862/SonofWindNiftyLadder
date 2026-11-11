import { assertNineThirtyRules } from "./nineThirtyRules";
import { xtsOwnOrderFill } from "./xtsOrder";

assertNineThirtyRules();

const book = {
  result: [
    { ExchangeInstrumentID: 999, OrderStatus: "Filled", CumulativeQuantity: 20, OrderAverageTradedPrice: 4.55 },
    { ExchangeInstrumentID: 25700, OrderStatus: "Filled", CumulativeQuantity: 65, OrderAverageTradedPrice: 108.4 },
  ],
};
const own = xtsOwnOrderFill(book, 25700);
if (!own || own.px !== 108.4 || own.qty !== 65) throw new Error("SENSEX 4.55 is not the NIFTY fill");
if (xtsOwnOrderFill(book, 111) !== null) throw new Error("another row is not this order");
const ack = { result: { OrderStatus: "Filled", CumulativeQuantity: 65, OrderAverageTradedPrice: 108.4 } };
const single = xtsOwnOrderFill(ack, 25700);
if (!single || single.px !== 108.4) throw new Error("one untagged place ack is this order");

console.log("nineThirty rules ok");
