import { describe, expect, it } from "vitest";

import {
  MONEY_NUMBER_INPUT_EXEMPTIONS,
  classifyNumberInput,
  jsxSourceFiles,
  scanSourceForMoneyNumberInputs,
  scanTreeForMoneyNumberInputs,
} from "./support/money-number-input-scan";

/*
  #2932 — the mechanical guard for `INV-MONEY-003`'s input half.

  The rule says a money box is `type="text"` with `inputMode="decimal"` —
  `MONEY_INPUT_PROPS` — because a `type="number"` control has already thrown
  away "50abc", "$45.00" and "1,000.00" by the time the exact parser runs, and
  every handler in this tree reads the `""` it hands over as "no value".
  #2685/#2712 wrote the rule and converted the surfaces of the day. Nothing
  stopped a new one appearing, and seven had.

  The deliverable here is as much the guard as the fix, and the hard half of the
  guard is DISCRIMINATION: around eighty `type="number"` controls in this tree
  are counts, percentages and durations, which are legitimately browser number
  inputs. A guard that flagged those would be disabled within a week. So the
  suite below proves the classifier in BOTH directions — it catches a seeded
  money box, and it stays silent on a seeded count, percentage and duration —
  rather than only proving that the tree is currently clean.
*/

/**
 * A money box, spelled the wrong way. The shape a future change would add.
 */
const SEEDED_MONEY_INPUT = `
export function Fixture() {
  return (
    <div>
      <Label htmlFor="nightly-rate">Nightly rate ($)</Label>
      <Input
        id="nightly-rate"
        type="number"
        min="0"
        step="0.01"
        value={nightlyRate}
        onChange={(event) => setNightlyRate(event.target.value)}
      />
    </div>
  );
}
`;

/**
 * The three legitimate kinds, each written the way this tree already writes
 * them. Every one of these MUST stay silent, including the two that carry a
 * money word — a refund percentage and an invoice due-day count — because that
 * is exactly the false positive that would get the guard switched off.
 */
const SEEDED_NON_MONEY_INPUTS: ReadonlyArray<{ kind: string; code: string }> = [
  {
    kind: "a count",
    code: `
      <Input
        id="max-guests"
        type="number"
        min="1"
        value={maxGuestsPerBooking}
        onChange={(event) => setMaxGuestsPerBooking(event.target.value)}
      />`,
  },
  {
    kind: "a bare count with no label at all",
    code: `
      <Input
        id="bulk-room-count"
        type="number"
        value={bulkRoomCount}
        onChange={(event) => setBulkRoomCount(event.target.value)}
      />`,
  },
  {
    kind: "a percentage that also names a refund",
    code: `
      <Label htmlFor="card-refund-percentage">Card Refund %</Label>
      <Input
        id="card-refund-percentage"
        type="number"
        value={rule.refundPercentage}
        onChange={(event) => updateRule({ refundPercentage: event.target.value })}
      />`,
  },
  {
    kind: "a duration that also names an invoice",
    code: `
      <Label htmlFor="subscription-due-days">Invoice due days</Label>
      <Input
        id="subscription-due-days"
        type="number"
        min={1}
        value={dueDays}
        onChange={(event) => setDueDays(event.target.value)}
      />`,
  },
  {
    kind: "a templated per-row id, which is not a dollar sign",
    code: `
      <Input
        id={\`count-\${tier}-\${request.id}\`}
        type="number"
        min="0"
        value={childCountValues(request)[tier]}
        onChange={(event) => setChildCount(tier, event.target.value)}
      />`,
  },
];

describe("money boxes are never browser number inputs (INV-MONEY-003, #2932)", () => {
  it("finds no money `type=\"number\"` control anywhere in the tree", () => {
    const found = scanTreeForMoneyNumberInputs();
    const exempt = new Set(
      MONEY_NUMBER_INPUT_EXEMPTIONS.map((entry) => entry.file),
    );
    const offending = found.filter((hit) => !exempt.has(hit.file));
    expect(
      offending.map(
        (hit) =>
          `${hit.file}:${hit.line} <${hit.tag}> looks like money ("${hit.matched}") but is a browser number input — spell it {...MONEY_INPUT_PROPS} from @/lib/money-input (INV-MONEY-003)`,
      ),
    ).toEqual([]);
  });

  it("scans a tree that actually contains the controls it is judging", () => {
    // A scanner pointed at nothing passes the test above vacuously. Around
    // eighty legitimate `type="number"` controls exist here; require the walk
    // to have reached a substantial tree before its silence means anything.
    expect(jsxSourceFiles().length).toBeGreaterThan(200);
  });

  it("catches a seeded money box — the regression direction", () => {
    const found = scanSourceForMoneyNumberInputs(
      "src/components/fixture.tsx",
      SEEDED_MONEY_INPUT,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(6);
    expect(found[0]?.matched.toLowerCase()).toBe("rate");
  });

  it.each(SEEDED_NON_MONEY_INPUTS)(
    "leaves $kind alone — the discrimination direction",
    ({ code }) => {
      expect(
        scanSourceForMoneyNumberInputs(
          "src/components/fixture.tsx",
          `export function Fixture() { return (<div>${code}</div>); }`,
        ),
      ).toEqual([]);
    },
  );

  it("lets a non-money unit outrank a money word, whichever comes first", () => {
    // The precedence, stated as its own case: this is the single decision the
    // whole classifier turns on, and reversing it is the mutation that makes
    // the guard unusable rather than merely weaker.
    expect(classifyNumberInput('value={refundPercentage}')).toBeNull();
    expect(classifyNumberInput('value={percentageOfFee}')).toBeNull();
    expect(classifyNumberInput('value={priceDollars}')).not.toBeNull();
  });

  it("states a reason for every exemption it carries", () => {
    for (const entry of MONEY_NUMBER_INPUT_EXEMPTIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(40);
    }
  });
});
