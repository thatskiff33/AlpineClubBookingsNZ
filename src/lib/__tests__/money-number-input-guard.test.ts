import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  MONEY_NUMBER_INPUT_EXEMPTIONS,
  REQUIRED_SCANNED_SUBTREES,
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
  guard is DISCRIMINATION: SEVENTY-THREE `type="number"` controls in this tree
  are counts, percentages and durations, which are legitimately browser number
  inputs. (Seventy-three measured, not estimated — an earlier draft of this file
  and of the scanner both said "around eighty", which is the kind of carried
  figure this repository's census convention exists to stop.) A guard that
  flagged those would be disabled within a week.

  So the suite proves the classifier in BOTH directions, and it measures both
  directions TOGETHER, because the #2932 review's changes pull opposite ways:
  widening the money vocabulary and narrowing the duration override flag more,
  while reading only the control's own identity attributes flags less.

  - forwards: the tree is clean now, and a seeded money box is caught;
  - backwards: every one of the seven boxes this change fixed is flagged in its
    ORIGINAL form, and still flagged once every helper and state name in it has
    been renamed away. That second half is what stops the guard passing for an
    accident — two of the seven were identified only by a word inside a helper
    name.
*/

/*
  The tree walk parses every non-test `.tsx` with the TypeScript parser, which
  costs a few seconds on its own and more under parallel load. Vitest's 5000 ms
  default expires there, so the budget is stated rather than left to luck - the
  same reasoning as `money-cents-guard.test.ts`, which pays an ESLint bootstrap.
*/
vi.setConfig({ testTimeout: 60_000 });

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
 * The legitimate kinds, each written the way this tree already writes them.
 * Every one of these MUST stay silent, including the two that carry a money
 * word — a refund percentage and an invoice due-day count — because that is
 * exactly the false positive that would get the guard switched off.
 *
 * The last two are the #2932 review's attribute-bleed findings, and they are
 * regression cases rather than illustrations: both shapes are already live in
 * this tree on boxes that are not `type="number"` today, so both were one
 * conversion away from firing.
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
    kind: "a duration that also names a payment",
    code: `
      <Label htmlFor="subscription-due-days">Invoice due days</Label>
      <Input
        id="subscription-due-days"
        type="number"
        min={1}
        value={paymentDueDays}
        onChange={(event) => setPaymentDueDays(event.target.value)}
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
  {
    kind: "a count sharing a field hint whose id names an amount",
    code: `
      <Label htmlFor="party-size">How many people?</Label>
      <Input
        id="party-size"
        type="number"
        min="1"
        value={partySize}
        aria-describedby={describedByFieldHint(PAYMENT_AMOUNT_HINT_ID)}
        onChange={(event) => setPartySize(event.target.value)}
      />`,
  },
  {
    kind: "a redemption total, which is a count and not an amount",
    code: `
      <Label htmlFor="maxRedemptionsTotal">Total redemptions allowed</Label>
      <Input
        id="maxRedemptionsTotal"
        type="number"
        min="1"
        value={maxRedemptionsTotal}
        onChange={(event) => setMaxRedemptionsTotal(event.target.value)}
      />`,
  },
];

/**
 * The seven boxes #2932 fixed, copied VERBATIM from `0caf8d56c^` — the commit
 * before the conversion. The guard has to flag all seven, or it would not have
 * caught the defect it was written for.
 */
const THE_SEVEN_BEFORE_THE_FIX: ReadonlyArray<{
  where: string;
  code: string;
}> = [
  {
    where: "member-credit-card.tsx:110 — the member credit adjustment amount",
    code: `
      <Input
        id="adj-amount"
        type="number"
        step="0.01"
        value={adjustmentAmount}
        onChange={(e) => onChangeAdjustmentAmount(e.target.value)}
        {...adjustmentAmountHint.fieldProps}
      />`,
  },
  {
    where: "member-xero-create-dialog.tsx:103 — a joining-fee override",
    code: `
      <Input
        id="member-detail-xero-entrance-amount"
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        placeholder="Use configured amount"
        value={entranceFeeAmount}
        onChange={(e) => onChangeEntranceFeeAmount(e.target.value)}
      />`,
  },
  {
    where: "member-xero-entrance-fee-fields.tsx:68 — the other joining-fee override",
    code: `
      <Input
        id={\`\${idPrefix}-amount\`}
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        placeholder="Use configured amount"
        value={decision.xeroEntranceFeeAmount}
        onChange={(event) => decision.setXeroEntranceFeeAmount(event.target.value)}
      />`,
  },
  {
    where: "refund-requests/page.tsx:582 — the refund approval amount",
    code: `
      <Input
        id="approvedAmount"
        type="number"
        step="0.01"
        min="0"
        max={(maxRefundable / 100).toFixed(2)}
        value={approvedAmount}
        onChange={(e) => setApprovedAmount(e.target.value)}
        disabled={!canEditFinance}
        title={!canEditFinance ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
        className="w-40"
      />`,
  },
  {
    where: "public-booking-requests-panel.tsx:1724 — the school quote total",
    code: `
      <Input
        id={\`price-\${request.id}-\${optionId}\`}
        type="number"
        min="0"
        step="0.01"
        className="w-32"
        disabled={actionsBlocked}
        value={optionTotalInputValue(request, optionId)}
        onChange={(event) =>
          setPriceInputs((prev) => ({
            ...prev,
            [priceInputKey(request.id, optionId)]: event.target.value,
          }))
        }
      />`,
  },
  {
    where: "public-booking-requests-panel.tsx:1767 — the per-guest-night rate",
    code: `
      <Input
        id={key}
        type="number"
        min="0"
        step="0.01"
        className="w-32"
        disabled={actionsBlocked}
        value={rateInputs[key] ?? suggestedRateDollars(request, combo)}
        onChange={(event) =>
          setRateInputs((prev) => ({ ...prev, [key]: event.target.value }))
        }
      />`,
  },
  {
    where: "whole-lodge-request-controls.tsx:346 — the whole-lodge price override",
    code: `
      <Input
        id={\`whole-lodge-price-\${requestId}\`}
        type="number"
        min="0"
        step="0.01"
        className="w-40"
        value={priceDollars}
        disabled={disabled}
        onChange={(event) => onPriceChange(event.target.value)}
      />`,
  },
];

const fixture = (code: string) =>
  `export function Fixture() { return (<div>${code}</div>); }`;

/**
 * Rename EVERY identifier inside a JSX expression container — every helper,
 * every state variable, every prop — while leaving string literals, template
 * literal text and label text exactly as they are.
 *
 * This models the mutation the guard has to survive: somebody renames
 * `suggestedRateDollars`, and the box it prefills stops being recognisable as
 * money. A control that is only flagged before this rename is flagged by
 * accident.
 */
function forEachExpressionIdentifier(
  source: string,
  visitor: (node: ts.Identifier, parsed: ts.SourceFile) => void,
): void {
  const parsed = ts.createSourceFile(
    "rename.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (node: ts.Node, insideExpression: boolean) => {
    const nowInside =
      insideExpression ||
      ts.isJsxExpression(node) ||
      ts.isJsxSpreadAttribute(node);
    if (nowInside && ts.isIdentifier(node)) visitor(node, parsed);
    ts.forEachChild(node, (child) => visit(child, nowInside));
  };
  visit(parsed, false);
}

function renameEveryIdentifier(source: string): string {
  const edits: Array<{ start: number; end: number }> = [];
  forEachExpressionIdentifier(source, (node, parsed) => {
    edits.push({ start: node.getStart(parsed), end: node.getEnd() });
  });
  let out = source;
  let n = edits.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}zz${n--}${out.slice(edit.end)}`;
  }
  return out;
}

/** Every name the rename above is supposed to have replaced. */
function survivingExpressionNames(source: string): string[] {
  const names: string[] = [];
  forEachExpressionIdentifier(source, (node) => {
    if (!/^zz\d+$/.test(node.text)) names.push(node.text);
  });
  return names;
}

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

  it("reaches every subtree it is supposed to be judging", () => {
    /*
      A scanner pointed at nothing passes the test above vacuously, and a size
      floor alone barely narrows that: this walk reaches 627 files, so the old
      "more than 200" left two thirds of it disableable in silence. Adding one
      directory name to the scanner's skip list is all it takes, and the subtree
      holding two of the seven boxes this change fixed is one `booking-requests`
      away. So bind the walk BY NAME instead — a missing subtree fails saying
      which one it is. The floor stays as a floor, never an equality: sibling
      lanes add and remove files under these paths constantly, and a total is a
      merge-conflict generator every one of them would have to re-measure.
    */
    const scanned = jsxSourceFiles().map((file) =>
      file.split("\\").join("/"),
    );
    const unreached = REQUIRED_SCANNED_SUBTREES.filter(
      (subtree) => !scanned.some((file) => file.includes(`/${subtree}/`)),
    );
    expect(unreached).toEqual([]);
    expect(scanned.length).toBeGreaterThan(400);
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
        scanSourceForMoneyNumberInputs("src/components/fixture.tsx", fixture(code)),
      ).toEqual([]);
    },
  );

  it.each(THE_SEVEN_BEFORE_THE_FIX)(
    "flags $where, as it stood before the fix",
    ({ code }) => {
      expect(
        scanSourceForMoneyNumberInputs("src/components/fixture.tsx", fixture(code)),
      ).toHaveLength(1);
    },
  );

  it.each(THE_SEVEN_BEFORE_THE_FIX)(
    "still flags $where once every helper and state name in it is renamed",
    ({ code }) => {
      const renamed = renameEveryIdentifier(fixture(code));
      // The mutation really did happen: not one helper, state variable, prop or
      // spread name is left anywhere an expression can hold one. What survives
      // is literal text somebody WROTE about this control — its id string, its
      // placeholder, its label — which is the distinction being asserted.
      expect(survivingExpressionNames(renamed)).toEqual([]);
      expect(
        scanSourceForMoneyNumberInputs("src/components/fixture.tsx", renamed),
      ).toHaveLength(1);
    },
  );

  it("lets a percentage outrank a money word, whichever comes first", () => {
    // The precedence, stated as its own case: reversing it is the mutation that
    // makes the guard unusable rather than merely weaker.
    expect(classifyNumberInput("{refundPercentage}")).toBeNull();
    expect(classifyNumberInput("{percentageOfFee}")).toBeNull();
    expect(classifyNumberInput("{priceDollars}")).not.toBeNull();
  });

  it("reads camelCase money names, which word boundaries alone cannot", () => {
    /*
      #2932 review: `\bfees?\b`, `\brates?\b`, `\bcosts?\b` and `\bcents?\b`
      never matched `nightlyRate`, `unitCost` or `bedFee`, because the character
      before the word is a word character. camelCase is this tree's dominant
      naming convention, so three of the four words the scanner advertised
      contributed nothing at all.
    */
    expect(classifyNumberInput("{nightlyRate}")).not.toBeNull();
    expect(classifyNumberInput("{unitCost}")).not.toBeNull();
    expect(classifyNumberInput("{bedFee}")).not.toBeNull();
    expect(classifyNumberInput("{feeCents}")).not.toBeNull();
    // And the boundaries still do their job on the words that need them.
    expect(classifyNumberInput("{percentOfTotal}")).toBeNull();
  });

  it("does not let a duration hide a box that also names dollars", () => {
    /*
      #2932 review: a non-money unit used to win OUTRIGHT, and the list held
      months and years, so "Price per year ($)" was classified as not-money
      despite carrying a money word AND a literal currency symbol. A duration
      now wins only when no currency symbol is present, which keeps the case the
      override was written for and drops the hole.
    */
    expect(classifyNumberInput('"annual-price" Price per year ($)')).not.toBeNull();
    expect(classifyNumberInput('"subscription-due-days" Invoice due days')).toBeNull();
    expect(classifyNumberInput("{paymentDueDays}")).toBeNull();
  });

  it("treats cent precision as a money signal a rename cannot erase", () => {
    // Nothing in the text says money; `step="0.01"` does. Measured on this
    // tree: no legitimate `type="number"` control asks for cent precision.
    expect(classifyNumberInput("{zz1}", true)).toBe('step="0.01"');
    expect(classifyNumberInput("{zz1}", false)).toBeNull();
    // It sits BELOW the overrides, not above them.
    expect(classifyNumberInput('"card-refund-percentage" Card Refund %', true)).toBeNull();
  });

  it("classifies from the control's own identity, never its layout or hints", () => {
    /*
      #2932 review, both directions of the same root cause. The classifier used
      to read the whole opening element, so a `%` anywhere in it — a Tailwind
      arbitrary value, `style={{ width: "100%" }}` — silently DISARMED the guard
      on a real money box, and an `aria-describedby` naming a shared amount hint
      ARMED it on a guest count.
    */
    const disarmedByLayout = `
      <Label htmlFor="nightly-rate">Nightly rate ($)</Label>
      <Input
        id="nightly-rate"
        type="number"
        step="0.01"
        style={{ width: "100%" }}
        className="w-[60%]"
        value={nightlyRate}
      />`;
    expect(
      scanSourceForMoneyNumberInputs("src/components/fixture.tsx", fixture(disarmedByLayout)),
    ).toHaveLength(1);
  });

  it("states a reason for every exemption it carries", () => {
    for (const entry of MONEY_NUMBER_INPUT_EXEMPTIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(40);
    }
  });
});
