import assert from "node:assert/strict";
import {
  bookLots,
  dayBookHit,
  dayMtm,
  loserHit,
  maxStopHit,
  pickNearestExpiry,
  pickSellStrike,
  sellQty,
  trailStep,
} from "./nineThirtyRules";

const today = new Date("2026-11-08T08:00:00+05:30");

assert.equal(
  pickNearestExpiry(
    [
      { label: "05Nov2026", api: "old" },
      { label: "08Nov2026", api: "same" },
      { label: "12Nov2026", api: "next" },
      { label: "12 Nov 2026", api: "spaced" },
      { label: "2026-11-10", api: "iso" },
    ],
    today,
  )?.api,
  "same",
);

assert.equal(pickNearestExpiry([{ label: "05Nov2026", api: "old" }], today), null);

const cheap = pickSellStrike([
  { strike: 25000, premium: 140, iid: 1 },
  { strike: 25100, premium: 105, iid: 2 },
  { strike: 24900, premium: 99.99, iid: 3 },
  { strike: 25200, premium: 105, iid: 4 },
]);
assert.equal(cheap?.iid, 2);

assert.equal(pickSellStrike([{ strike: 1, premium: 99.99, iid: 1 }]), null);
assert.equal(pickSellStrike([{ strike: 1, premium: 100, iid: 9 }])?.iid, 9);

assert.equal(sellQty(65, 1), 65);
assert.equal(sellQty(20, 2), 40);
assert.equal(sellQty(30, 0), null);
assert.equal(sellQty(30, 51), null);

assert.equal(
  dayMtm([
    { sold: 100, mark: 80, qty: 65, open: true },
    { sold: 100, mark: 110, qty: 65, open: false },
  ]),
  (100 - 80) * 65 + (100 - 110) * 65,
);
assert.equal(dayMtm([{ sold: 100, mark: null, qty: 65, open: true }]), null);

assert.equal(
  bookLots([
    { side: "CE", qty: 130, lotSize: 65, open: true, openedAt: 2 },
    { side: "PE", qty: 65, lotSize: 65, open: true, openedAt: 1 },
  ]),
  2,
);
assert.equal(dayBookHit(1000, 2), "win");
assert.equal(dayBookHit(-1400, 2), "loss");
assert.equal(dayBookHit(999, 2), null);
assert.equal(dayBookHit(-1399, 2), null);
assert.equal(dayBookHit(500, 1), "win");
assert.equal(dayBookHit(-700, 1), "loss");

assert.equal(loserHit(100, 125), true);
assert.equal(loserHit(100, 124.99), false);
assert.equal(maxStopHit(100, 115), true);
assert.equal(maxStopHit(100, 114.99), false);

const armed = trailStep(100, 60, false, null);
assert.equal(armed.justArmed, true);
assert.equal(armed.low, 60);
assert.equal(armed.cover, false);

const tighter = trailStep(100, 50, true, 60);
assert.equal(tighter.low, 50);
assert.equal(tighter.cover, false);

const cover = trailStep(100, 57.5, true, 50);
assert.equal(cover.cover, true);
assert.equal(cover.low, 50);

const held = trailStep(100, 55, true, 50);
assert.equal(held.low, 50);
assert.equal(held.cover, false);

const back = trailStep(100, 70, true, 50);
assert.equal(back.low, 50);
assert.equal(back.cover, true);

console.log("nineThirty rules ok");
