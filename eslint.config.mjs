import { fixupConfigRules } from "@eslint/compat";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// #2264 — the three date-rendering restrictions, named so the "Number
// formatting only" block below can re-state the two date ones while dropping
// just `toLocaleString`, instead of switching the whole rule off.
//
// All three enforce INV-DATE-015 (`docs/invariants/booking-dates-and-capacity.md`),
// and each message opens with that id so whoever trips the rule is handed the
// rule it belongs to rather than only the fix (#2691).
const NO_BARE_TO_LOCALE_DATE_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleDateString']",
  message:
    "INV-DATE-015: Render through @/lib/club-time (CT-2, #2990). Holding a lodge night, a birthday or any other CALENDAR DAY? formatClubDate / formatClubLongDate / formatClubWeekdayDate / formatClubMonthYear, which take no timezone because a calendar day has none. Holding a real INSTANT such as createdAt? formatClubInstantDate / formatClubInstantDateTime and their siblings, with the club zone from clubTime() (@/lib/club-time/server) on the server or received as data on the client. A bare toLocaleDateString renders in the viewer's zone and locale (#2256, #2264). There is no second seam: #3123 deleted @/lib/nzst-date, so the kernel is the only one — do not build another.",
};

const NO_BARE_TO_LOCALE_TIME_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleTimeString']",
  message:
    "INV-DATE-015: Use formatClubInstantTime / formatClubInstantDateTime from @/lib/club-time (CT-2, #2990), with the club zone from clubTime() (@/lib/club-time/server) on the server or received as data on the client. A bare toLocaleTimeString renders in the viewer's zone and locale (#2256, #2264). There is no second seam: #3123 deleted @/lib/nzst-date, so the kernel is the only one — do not build another.",
};

const NO_BARE_TO_LOCALE_STRING = {
  selector:
    "CallExpression > MemberExpression.callee[property.name='toLocaleString']",
  message:
    "INV-DATE-015: Use formatClubInstantDateTime / formatClubInstantDate from @/lib/club-time (CT-2, #2990) for an instant, or formatClubDate for a calendar day, which takes no timezone at all. A bare toLocaleString on a Date renders in the viewer's zone and locale (#2256, #2264). Formatting a NUMBER? Add the file to the Number-formatting block in this config with a one-line reason. There is no second seam: #3123 deleted @/lib/nzst-date, so the kernel is the only one — do not build another.",
};

// #2289 — the two shapes of raw SQL that can lie about their own result.
//
// `prisma.$queryRaw<SomeRow[]>` is an UNCHECKED CAST. Raw SQL returns the
// PHYSICAL column names; the type argument declares whatever the author
// believed. Nothing verifies the two agree — not the compiler (the cast silences
// it) and not the tests (a mocked Prisma returns the shape the author believed,
// which is the same wrong belief). Where they disagreed in a real deployment,
// every property arrived `undefined`: `maxRedemptionsTotal` undefined made
// `!== null` true and `n > undefined` false, so a promo's total-redemption cap
// never fired, and `freeNightsPerIndividual` undefined made `?? 0` yield zero,
// so FREE_NIGHTS promos applied no discount at booking creation while the quote
// path showed the member one. Members were quoted a discount and charged without
// it, for months, with nothing logged.
//
// The type argument IS the hazard, so it is the thing banned. It cannot tell you
// a column name is wrong — only that somebody asserted a shape without checking
// it. Two honest alternatives remain, and the message names both.
//
// BOTH CALL FORMS ARE COVERED, deliberately. Prisma accepts a raw statement as a
// tagged template (``$queryRaw`SELECT …` ``) AND as an ordinary call taking a
// composed `Prisma.Sql` (`$queryRaw(Prisma.sql`SELECT …`)`) — and the second is
// this repository's own idiom for anything longer than a one-liner
// (`src/lib/audit-retention.ts` builds its archive statements that way). A rule
// that only matched the tagged template would leave the exact banned pattern —
// typed cast, `SELECT *`, `FOR UPDATE` on a read — passing lint in the style the
// codebase already uses, which is worse than no rule because it reads as covered.
//
// Both messages enforce INV-OPS-001 (`docs/invariants/operations.md`), which
// names these rules and the census test beside them as its two enforcement arms,
// and both open with that id (#2691).
const RAW_SQL_METHOD = "/^\\$(queryRaw|executeRaw)(Unsafe)?$/";
const RESULT_CAST_MESSAGE =
  "INV-OPS-001: Do not type a raw-SQL result: `$queryRaw<T>` is an unchecked cast and a wrong column name arrives as `undefined`, not as an error (#2289). Taking a row lock? Use `$executeRaw` on a statement selecting a constant (`SELECT 1 … FOR UPDATE`) and read what you need through the Prisma model. Genuinely cannot express it as a model read? Validate the rows with `decodeRawRows` from @/lib/raw-sql-rows.";
const SELECT_STAR_MESSAGE =
  "INV-OPS-001: Do not `SELECT *` in a raw statement (#2289): the returned column set becomes whatever the database currently has, so a migration changes the result shape with nothing in the source to review. Name the columns — or, if the statement is only there for a row lock, select a constant (`SELECT 1 … FOR UPDATE`).";

// `$queryRaw<T>`…`` — the tagged-template cast.
const NO_RAW_SQL_RESULT_CAST = {
  selector: `TaggedTemplateExpression[typeArguments][tag.property.name=${RAW_SQL_METHOD}]`,
  message: RESULT_CAST_MESSAGE,
};

// `$queryRaw<T>(Prisma.sql`…`)` and `$queryRawUnsafe<T>("…")` — the same cast
// written as a call. One selector covers all four methods.
const NO_RAW_SQL_CALL_RESULT_CAST = {
  selector: `CallExpression[typeArguments][callee.property.name=${RAW_SQL_METHOD}]`,
  message: RESULT_CAST_MESSAGE,
};

// `SELECT *` in a raw statement is the same hazard one step earlier: it makes the
// returned column set whatever the DATABASE currently happens to have, so the
// statement silently changes shape when a migration does — and there is nothing
// in the source to review it against. Name the columns you actually want.
//
// Four selectors because the SQL text can reach the driver four ways, and the
// three below the first are precisely the ones the tagged-template rule missed.
const NO_SELECT_STAR_IN_RAW_SQL = {
  selector: `TaggedTemplateExpression[tag.property.name=${RAW_SQL_METHOD}] TemplateElement[value.raw=/SELECT\\s+\\*/i]`,
  message: SELECT_STAR_MESSAGE,
};

// `$queryRawUnsafe(`SELECT * …`)` — a template literal passed as an argument.
// The child combinator keeps this off `Prisma.sql`…`` arguments, which the
// composition rule below reports instead, so nothing is flagged twice.
const NO_SELECT_STAR_IN_RAW_SQL_CALL = {
  selector: `CallExpression[callee.property.name=${RAW_SQL_METHOD}] > TemplateLiteral TemplateElement[value.raw=/SELECT\\s+\\*/i]`,
  message: SELECT_STAR_MESSAGE,
};

// `$queryRawUnsafe("SELECT * …")` — a plain string argument.
const NO_SELECT_STAR_IN_RAW_SQL_STRING = {
  selector: `CallExpression[callee.property.name=${RAW_SQL_METHOD}] > Literal[value=/SELECT\\s+\\*/i]`,
  message: SELECT_STAR_MESSAGE,
};

// ``Prisma.sql`SELECT * …` `` — anchored on the composition helper rather than on
// the call, so a statement built into a variable and passed to `$queryRaw` on a
// later line is still caught. `Prisma.sql` exists only to build SQL, so there is
// no false-positive surface here.
const NO_SELECT_STAR_IN_PRISMA_SQL = {
  selector:
    'TaggedTemplateExpression[tag.object.name="Prisma"][tag.property.name="sql"] TemplateElement[value.raw=/SELECT\\s+\\*/i]',
  message: SELECT_STAR_MESSAGE,
};

// #2685 — building integer cents inline, instead of at one of the two reviewed
// money boundaries.
//
// Two different mistakes wear the same shape, `something * 100`:
//
//  1. TEXT a person typed. `Math.round(parseFloat(value) * 100)` sends a decimal
//     the person wrote through a binary double, which cannot hold most decimal
//     fractions exactly; `parseFloat` also accepts "50abc" as 50 and returns
//     `NaN` for anything it cannot read at all — and several call sites turned
//     that `NaN` into `0`, or into a `JSON.stringify` `null`, so a typo saved a
//     nightly rate of $0.00 or filed a refund appeal with no amount, silently.
//     `parseDecimalDollarsToCents` reads the digit groups as integers instead,
//     and returns `null` so the caller must show an error.
//  2. A NUMBER a provider already parsed. Xero hands over a JavaScript number,
//     so the decimal source text is gone and the exact parser cannot be used.
//     That conversion belongs at `providerAmountToCents`, the single reviewed
//     rounding boundary, not in twenty-five inline copies.
//
// THE RULE MATCHES THE COMPOSITION, NOT A FUNCTION NAME. Banning `parseFloat`
// was measured on this tree and rejected: every non-test call either already
// ended in a `* 100` (so it adds no coverage) or parses OKLCH colour tokens in
// `club-theme-schema.ts` (so it adds four false positives), and it would miss
// the `Number()`-based parser entirely.
//
// WHAT IT DELIBERATELY DOES NOT MATCH: `ratio * 100` for a percentage —
// occupancy, success rate, setup progress, Xero API budget use — and
// `Math.round(n * 100) / 100` two-decimal rounding in `src/lib/theme/`. There
// are two dozen of those and they are all legitimate; the negative fixtures in
// `money-cents-guard.test.ts` pin every shape.
//
// All of them enforce INV-MONEY-003 (`docs/invariants/money.md`) and open with
// that id, so whoever trips one is handed the rule (#2691).
const MONEY_CENTS_MESSAGE =
  "INV-MONEY-003: Do not build cents inline. Money a PERSON typed goes through parseDecimalDollarsToCents (or parseSignedDecimalDollarsToCents where a negative is a real amount) from @/lib/money-input — it parses the decimal digits exactly and returns null, which you must surface as a validation error rather than a silent $0.00. An ALREADY-NUMERIC provider amount, such as a Xero API number, goes through providerAmountToCents from @/lib/money-provider-amount, the one reviewed rounding boundary. Xero REPORT cell text, which arrives with thousands separators and accountants' bracket negatives, goes through parseProviderReportAmountToCents from the same module — the typed-money parser refuses both of those. Computing a PERCENTAGE rather than cents, or otherwise sure this rule has misfired? Add the file to MONEY_GUARD_EXEMPTIONS in eslint.config.mjs with a written reason — that list is the escape hatch and it is read by money-cents-guard.test.ts, so adding to it passes CI. Never an eslint-disable comment (#2685).";

// A numeric-parse call anywhere inside an expression that is multiplied by 100.
// The descendant combinator is what makes alternate spellings and compositions
// fail too: `(parseFloat(x) || 0) * 100` and `(Number(a) + Number(b)) * 100`
// are the same mistake as `parseFloat(x) * 100` and are all caught here, where
// a selector anchored on the operand itself would let both through.
const PARSE_CALL_SELECTORS = [
  'CallExpression[callee.name=/^(Number|parseFloat|parseInt)$/]',
  'CallExpression[callee.object.name="Number"][callee.property.name=/^(parseFloat|parseInt)$/]',
];

// A binding whose name ends in `Cents`. That suffix is not a guess about English
// — it is this repository's own money convention (INV-MONEY-001), and nothing
// ever stores a percentage in one, which is what lets this arm catch a
// conversion built from a plain variable without touching the percentages.
const CENTS_TARGET_SELECTOR =
  ':matches(VariableDeclarator[id.name=/[Cc]ents$/], AssignmentExpression[left.name=/[Cc]ents$/], AssignmentExpression[left.property.name=/[Cc]ents$/], Property[key.name=/[Cc]ents$/], PropertyDefinition[key.name=/[Cc]ents$/])';

const TIMES_100_SELECTORS = [
  'BinaryExpression[operator="*"][right.value=100]',
  'BinaryExpression[operator="*"][left.value=100]',
];

// The same multiplication, minus the one shape that is a percentage by
// construction: a DIVISION sitting directly inside it. `(calls / budget) * 100`,
// `(beds / capacity) * 100` and `(settled / limit) * 100` are ratios scaled to a
// percentage, and nothing in this repository builds cents that way — a cents
// conversion scales an amount, not a quotient. Excluding it is what lets the
// broad arm below cover the payment modules without making the obvious fix to
// `xero-api-usage.ts`'s fractional `usagePercent` illegal to write.
//
// The residue this gives up is narrow, but it is only narrow because the two
// arms below put the rest back: a quotient of PARSED TEXT scaled to cents, and a
// quotient of anything else scaled INTO a `…Cents` binding, are both still
// caught. What is genuinely given up is `(a / b) * 100` that really is money,
// built from neither typed text nor a `…Cents` destination — indistinguishable,
// by shape or by name, from the occupancy percentage two lines above it.
const TIMES_100_NOT_A_RATIO_SELECTORS = [
  'BinaryExpression[operator="*"][right.value=100]:not([left.type="BinaryExpression"][left.operator="/"])',
  'BinaryExpression[operator="*"][left.value=100]:not([right.type="BinaryExpression"][right.operator="/"])',
];

// Scaling to cents WITHOUT a `* 100` anywhere in the source.
//
//   * `c *= 100` is the compound-assignment spelling, and it escaped every arm —
//     including the broad money-module one — because there is no
//     `BinaryExpression` to match. It is the shape one refactoring step away
//     from `const c = parseFloat(raw); c *= 100;`.
//   * `x / 0.01` is `x * 100` written as a division. Dividing by a hundredth is
//     never anything else.
const SCALED_TO_CENTS_WITHOUT_TIMES_100_SELECTORS = [
  'AssignmentExpression[operator="*="][right.value=100]',
  'BinaryExpression[operator="/"][right.value=0.01]',
];

const MONEY_CENTS_RESTRICTIONS = [
  // Arm 1 — an inline numeric parse scaled to cents.
  ...TIMES_100_SELECTORS.flatMap((times100) =>
    PARSE_CALL_SELECTORS.map((parseCall) => `${times100} ${parseCall}`),
  ),
  // Arm 2 — a unary `+` coercion scaled to cents (`+input * 100`).
  'BinaryExpression[operator="*"][right.value=100][left.type="UnaryExpression"][left.operator="+"]',
  'BinaryExpression[operator="*"][left.value=100][right.type="UnaryExpression"][right.operator="+"]',
  // Arm 3 — anything scaled to cents ON THE WAY INTO a `…Cents` binding, MINUS
  // the two shapes arms 1 and 2 have already reported. `parseFloat(raw) * 100`
  // and `parseFloat(raw)` begin at the same column, so without these exclusions
  // the commonest real mistake printed the identical message twice at the
  // identical line:column, and a 25-site regression printed fifty of them
  // (#2685 review). The exclusions mirror arms 1 and 2 exactly — a parse call
  // anywhere inside, or a unary `+` as the scaled operand — so nothing stops
  // being reported, it is reported once.
  ...[
    `BinaryExpression[operator="*"][right.value=100]:not(:has(:matches(${PARSE_CALL_SELECTORS.join(", ")}))):not([left.type="UnaryExpression"][left.operator="+"])`,
    `BinaryExpression[operator="*"][left.value=100]:not(:has(:matches(${PARSE_CALL_SELECTORS.join(", ")}))):not([right.type="UnaryExpression"][right.operator="+"])`,
  ].map((times100) => `${CENTS_TARGET_SELECTOR} ${times100}`),
  // Arm 5 — the two spellings that carry no `* 100` at all.
  ...SCALED_TO_CENTS_WITHOUT_TIMES_100_SELECTORS,
].map((selector) => ({ selector, message: MONEY_CENTS_MESSAGE }));

// Inside the money-domain modules themselves, a bare `x * 100` is a cents
// conversion and nothing else — these files compute no occupancy percentages and
// no theme ratios, which is exactly why the broad selector is safe here and
// nowhere else. This is the arm that catches a fresh
// `return Math.round(invoice.total * 100)` written straight into a Xero module,
// and equally `const d = parseFloat(raw); const c = Math.round(d * 100);`, which
// the shape-based arms above cannot see because the parse and the scaling are in
// different statements.
//
// WHAT THE BROAD ARM DOES AND DOES NOT COVER — stated exactly, because getting
// this wrong is what opened a hole. It covers arms 1–3 for ANY `x * 100` whose
// scaled operand is not a division: whatever `x` is, the broad selector already
// matches the same node, so re-stating the narrower arms for that shape would
// only report one mistake two and three times over. It does NOT cover the shape
// its own `:not(...)` exclusion removes — a division sitting inside the
// multiplication — and there the narrower arms are the only cover there ever
// was. Both arms below put that back:
//
//   * RATIO_OF_PARSE_SELECTORS — a quotient of PARSED TEXT scaled to cents,
//     `(parseFloat(gross) / 1.15) * 100` (GST-exclusive), `(parseFloat(raw) /
//     guests) * 100` (per-guest share), `(parseFloat(line.total) / line.qty) *
//     100` (unit price). Every one of those is money built from typed text, and
//     without this arm all three converted unguarded in every money module and
//     every API route while the identical line was caught in an ordinary
//     `src/lib` file — the guard at its weakest exactly where money lives.
//   * RATIO_INTO_CENTS_SELECTORS — a quotient of anything else scaled INTO a
//     `…Cents` binding, where the repository's own naming convention says the
//     result is money.
//
// A ratio with NEITHER a parse inside it nor a `…Cents` destination stays legal,
// which is the whole point of the exclusion: `(calls / budget) * 100` and
// `(beds / capacity) * 100` are percentages, and they are spelled this way
// inside these very files.
const PARSE_CALL_MATCHES = `:matches(${PARSE_CALL_SELECTORS.join(", ")})`;

const RATIO_OF_PARSE_SELECTORS = [
  `BinaryExpression[operator="*"][right.value=100][left.type="BinaryExpression"][left.operator="/"] ${PARSE_CALL_MATCHES}`,
  `BinaryExpression[operator="*"][left.value=100][right.type="BinaryExpression"][right.operator="/"] ${PARSE_CALL_MATCHES}`,
];

// The same exclusion arm 3 carries, and for the same reason: a parse anywhere
// inside the quotient is reported by the arm above, anchored on the parse call.
// Without it, `const amountCents = Math.round((parseFloat(x) / n) * 100);`
// printed the identical message twice — once at the multiplication and once at
// the parse one column along — which is the duplicate-reporting defect the
// earlier review already made this config fix once (#2685 review).
const RATIO_INTO_CENTS_SELECTORS = [
  `${CENTS_TARGET_SELECTOR} BinaryExpression[operator="*"][right.value=100][left.type="BinaryExpression"][left.operator="/"]:not(:has(${PARSE_CALL_MATCHES}))`,
  `${CENTS_TARGET_SELECTOR} BinaryExpression[operator="*"][left.value=100][right.type="BinaryExpression"][right.operator="/"]:not(:has(${PARSE_CALL_MATCHES}))`,
];

const MONEY_MODULE_RESTRICTIONS = [
  ...TIMES_100_NOT_A_RATIO_SELECTORS,
  ...RATIO_OF_PARSE_SELECTORS,
  ...RATIO_INTO_CENTS_SELECTORS,
  ...SCALED_TO_CENTS_WITHOUT_TIMES_100_SELECTORS,
].map((selector) => ({ selector, message: MONEY_CENTS_MESSAGE }));

/**
 * The two money arm families as bare selector strings, for
 * `money-cents-guard.test.ts`.
 *
 * The suite resolves this config through ESLint's own
 * `calculateConfigForFile()` at a roster of real production paths and checks the
 * resolved rule still carries every selector the family declares. It reads them
 * from HERE rather than from a copy, because a copied list passes happily while
 * the config that ships has dropped the rule — which is the whole failure mode
 * this file's guards exist to prevent. The suite pins a floor on the LENGTH of
 * each family, and its lint-a-real-fixture cases pin the behaviour, so emptying
 * one of these arrays does not quietly empty the expectation with it.
 */
export const MONEY_GUARD_ARMS = {
  standard: MONEY_CENTS_RESTRICTIONS.map((entry) => entry.selector),
  moneyModule: MONEY_MODULE_RESTRICTIONS.map((entry) => entry.selector),
};

/**
 * THE ESCAPE HATCH, and the only one. Each entry lifts the money restrictions
 * from one path and states in writing why that path is allowed to build cents
 * itself. There are no `eslint-disable` comments for this rule, and a new entry
 * here should be read as a site that was never classified.
 *
 * `money-cents-guard.test.ts` reads THIS array rather than a copy of it, and
 * fails on an entry with no reason — so the instruction the rule's own message
 * gives ("add the file with a written reason") is a move that actually passes
 * CI. It did not used to be: the test hard-coded the two helper paths, so a
 * developer told to add a third had no legal option at all (#2685 review).
 */
export const MONEY_GUARD_EXEMPTIONS = [
  {
    file: "src/lib/money-input.ts",
    reason:
      "The canonical exact text parser. It combines the integer dollar and cent groups with `dollars * 100 + cents`, which is the arithmetic every other file is being sent here to use.",
  },
  {
    file: "src/lib/money-provider-amount.ts",
    reason:
      "The reviewed provider boundary. It owns `Math.round(value * 100)` for already-numeric amounts, and the documented legacy float fallback for a Xero report cell whose magnitude falls outside the canonical grammar.",
  },
];

const MONEY_HELPER_MODULES = MONEY_GUARD_EXEMPTIONS.map((entry) => entry.file);

// Where a bare `x * 100` is money by construction.
//
// The families are matched by PREFIX so the guard follows the code through an
// ordinary rename or a split into a directory — the earlier hand-written list
// missed `src/lib/xero.ts` (the facade: `xero-*` does not match `xero`), had no
// `/**` form for `membership-cancellation-*` although the other two families
// did, and matched `.ts` only, so moving one module to `.tsx` would have dropped
// it silently (#2685 review).
//
// The named modules are the rest of the money surface the census found: the
// payment, credit, promo, fee, invoice and pricing modules, plus every API
// route, all of which convert money and none of which computes a percentage.
// `src/lib/admin-payments-service.ts` is the one the issue itself calls
// "invisible to any rule keyed off parseFloat or Math.round" — it is visible to
// this arm.
//
// Still deliberately NOT here: the Xero ADMIN SCREENS under
// `src/app/(admin)/admin/xero/`, which render API-budget percentages with the
// same `usagePercent * 100` shape, and are correct.
const MONEY_DOMAIN_MODULES = [
  "src/lib/xero.ts",
  "src/lib/xero-*.{ts,tsx}",
  "src/lib/xero-*/**/*.{ts,tsx}",
  "src/lib/finance-*.{ts,tsx}",
  "src/lib/finance-*/**/*.{ts,tsx}",
  "src/lib/membership-cancellation-*.{ts,tsx}",
  "src/lib/membership-cancellation-*/**/*.{ts,tsx}",
  "src/lib/*payment*.{ts,tsx}",
  "src/lib/*credit*.{ts,tsx}",
  "src/lib/*refund*.{ts,tsx}",
  "src/lib/*promo*.{ts,tsx}",
  "src/lib/*fee*.{ts,tsx}",
  "src/lib/*invoice*.{ts,tsx}",
  "src/lib/*subscription*.{ts,tsx}",
  "src/lib/pricing.ts",
  "src/lib/stripe.ts",
  "src/lib/stripe-*.{ts,tsx}",
  "src/app/api/**/*.{ts,tsx}",
];

// Flat config REPLACES a rule's whole option list rather than merging it, so
// every block that sets `no-restricted-syntax` for its own reasons has to
// re-state these. Keeping them in one array is what stops a future exemption
// block from silently dropping the raw-SQL guard along with the rule it meant to
// lift (#2289).
const RAW_SQL_RESTRICTIONS = [
  NO_RAW_SQL_RESULT_CAST,
  NO_RAW_SQL_CALL_RESULT_CAST,
  NO_SELECT_STAR_IN_RAW_SQL,
  NO_SELECT_STAR_IN_RAW_SQL_CALL,
  NO_SELECT_STAR_IN_RAW_SQL_STRING,
  NO_SELECT_STAR_IN_PRISMA_SQL,
];

// The same hazard, one rule later: every block below that sets
// `no-restricted-syntax` must re-state the money restrictions as well, or the
// block silently lifts them along with whatever it meant to lift.
// `src/lib/__tests__/money-cents-guard.test.ts` fails the build if one ever
// does (#2685).

// #2684 — the date-only ENCODING must be written once, in `src/lib/date-only.ts`.
//
// A lodge night, a stay bound, a finance window edge and a Xero document date
// are all `yyyy-MM-dd`, and the codebase had 119 hand-written copies of the
// truncation that produces one, in five spellings: `.slice(0, 10)`,
// `.substring(0, 10)`, `.substr(0, 10)`, and `.split("T")[0]` in either quote
// style. That is a maintainability problem on its own, but the reason it is a
// LINT rule rather than a style note is what the duplication hides.
//
// The truncation is only correct for a DATE-ONLY receiver. A `@db.Date` column
// is pinned to UTC midnight as the ENCODING of a CLUB calendar day and not as a
// moment (INV-DATE-010), so reading the UTC day back returns the day it encodes
// — INV-DATE-019's first exact boundary, over the columns INV-DATE-026
// establishes as calendar days; those are the citation for a decode, and
// INV-DATE-010 is not (#3080). A bare `DateTime`
// is a real instant, and New Zealand runs 12-13 hours ahead of UTC, so its UTC
// day is the PREVIOUS NZ day for roughly the first half of every NZ day — which
// is how a Xero invoice due date and a finance export both landed a day early
// (#2697, INV-DATE-019), and how #2682's fifteen "today" sites went wrong before
// them. The two cases are indistinguishable at a glance and identical in syntax;
// the only thing that separates them is what the value MEANS.
//
// Scattered across 119 sites nobody could audit that. Routed through named
// helpers, the choice is written down at every call: `formatDateOnly` for a
// date-only value, `formatDateOnlyForTimeZone` for an instant,
// `todayDateOnlyForTimeZone` / `getTodayDateOnly` for "today" (INV-DATE-019).
// This rule only enforces that the choice is MADE somewhere named; which one is
// right for a given receiver is what `date-only-encoding-guard.test.ts` checks,
// because a syntactic rule cannot see a Prisma column type.
//
// A WRAPPER DOES NOT GET A FREE PASS, but it is also not impossible — and this
// comment used to claim otherwise. The rule is over the syntax wherever it
// appears in `src/**`, so the forbidden pattern is illegal inside a helper's own
// body as much as at a call site, which matters because one exported
// `formatDate` one-liner in `xero-invoice-helpers` was enough to put roughly
// eighteen live Xero document dates beyond reach of the #2682 spelling census.
// What defeats a selector anchored on the truncation is a wrapper that takes ONE
// intermediate step — `const iso = d.toISOString(); return iso.slice(0, 10);` —
// because the slice's receiver is then a plain identifier. That is `formatDate`
// reconstituted and harder to spot, so `NO_TRUNCATION_ASSEMBLED_IN_A_WRAPPER`
// below matches the function that contains both halves. The only body in `src/`
// allowed to contain the truncation is the helper module exempted below, and the
// guard test additionally refuses an EXPORTED bare delegation so the blind spot
// cannot re-form under a new name.
//
// KNOWN LIMITATION (accepted, and the same one INV-DATE-015's rule carries). The
// selectors are syntactic, so they match spellings rather than meanings. Named
// exactly, what still gets through today is:
//
//   * a DETACHED METHOD ALIAS — `const f = d.toISOString; f().slice(0, 10)`;
//   * the truncation assembled across TWO functions — one returning the ISO
//     string, another cutting it — rather than inside one. The wrapper arm below
//     is scoped to a single function body on purpose: widening it to "calls
//     toISOString anywhere, slices ten characters anywhere" was measured and
//     reported two real files where the two halves are unrelated, so the loose
//     version costs more than it catches;
//   * a bare `.slice(0, 10)` on a value ALREADY serialised to a string, where
//     nothing in the expression says it is a date. This one is deliberate:
//     `.slice(0, 10)` on a string is indistinguishable from an array take-10 or
//     an ordinary text truncation, and this tree has both, so banning it would
//     be a false-positive generator rather than a guard;
//   * an encoding derived from a NON-UTC clock face — `getFullYear()` and
//     friends — which is a different defect (the BROWSER's calendar day) that
//     INV-DATE-014 and #2474 own, not this rule.
//
// What IS covered, and was not before this list was measured against real lint
// runs: every `(0, 10)` cut of a `toISOString()`/`toJSON()` result including
// through computed access (`d["toISOString"]()`), the same cut assembled through
// a local inside one function, `.split("T")` taken with `[0]`, `.at(0)` or
// `.shift()` and with the separator written as a string or as `/T/`, the
// `.replace(/T.*$/, "")` spelling, and the encoding assembled from UTC parts in
// a template literal — which was live in three files, and which no arm of this
// rule could see until it was added.
const DATE_TRUNCATION_MESSAGE =
  "INV-DATE-019: Do not hand-write an ISO date truncation (#2684). New code goes to @/lib/club-time (CT-2, #2990): clubCalendarDateOf(instant, zone) for a real INSTANT such as `createdAt`, whose UTC day is the PREVIOUS club day all morning (#2697); calendarDateOfDateOnlyInstant(value) for a `@db.Date` column, whose UTC midnight IS the encoding of a club calendar day (INV-DATE-010); clubToday(zone) for today. The @/lib/date-only equivalents (formatDateOnly / formatMonthOnly / formatDateOnlyForTimeZone / getTodayDateOnly) are the compatibility adapters CT-6 retires.";

const DATE_SPLIT_MESSAGE =
  "INV-DATE-019: Do not hand-write an ISO date truncation (#2684). Holding a Date? @/lib/club-time (CT-2, #2990): calendarDateOfDateOnlyInstant for a `@db.Date` value (INV-DATE-010) or clubCalendarDateOf(instant, zone) for a real instant. Holding a value already serialised to a string? parseCalendarDate, or dateOnlyFromIsoString from the @/lib/date-only adapter.";

// The ISO producers, spelled both ways a member access can reach them:
// `d.toISOString()` reads `callee.property.name`, `d["toISOString"]()` reads
// `callee.property.value`. The computed form was named in this file's own
// limitations paragraph as something that slipped past — it does not any more.
const ISO_PRODUCER_SELECTORS = [
  "[callee.object.callee.property.name=/^(toISOString|toJSON)$/]",
  "[callee.object.callee.property.value=/^(toISOString|toJSON)$/]",
];

// `d.toISOString().slice(0, 10)` and its `substring` / `substr` spellings.
const NO_HAND_WRITTEN_DATE_ONLY_TRUNCATION = ISO_PRODUCER_SELECTORS.map(
  (producer) => ({
    selector: `CallExpression[callee.property.name=/^(slice|substring|substr)$/]${producer}`,
    message: DATE_TRUNCATION_MESSAGE,
  }),
);

// `.replace(/T.*$/, "")` — the same cut written as a substitution, on a `Date`
// or on a string that is already ISO.
//
// Anchored on the PATTERN, not on the receiver, which was measured rather than
// assumed. Anchoring on the receiver instead — any `.replace()` on a
// `toISOString()` result — read as the tighter rule and was in fact far looser:
// it reported `new Date().toISOString().replace(/[:.]/g, "-")` in
// `src/lib/backup.ts`, which builds a filename out of the WHOLE timestamp and
// truncates nothing. A regex beginning with a capital `T` followed by a wildcard
// is the time half of an ISO value and cannot be much else.
const NO_ISO_DATE_REPLACE = {
  selector:
    'CallExpression[callee.property.name="replace"][arguments.0.regex.pattern=/^T[.*+?]/]',
  message: DATE_TRUNCATION_MESSAGE,
};

// The head of a split on a capital T, taken any of the three ways JavaScript
// offers, with the separator written as a string or as a regex. Including on a
// value that is ALREADY a string, because splitting on a capital T and keeping
// the front has exactly one meaning.
const SPLIT_ON_T_SELECTORS = [
  "[object.callee.property.name='split'][object.arguments.0.value='T']",
  "[object.callee.property.name='split'][object.arguments.0.regex.pattern='T']",
];

const NO_ISO_DATE_SPLIT_ON_T = [
  // `parts[0]`
  ...SPLIT_ON_T_SELECTORS.map((split) => ({
    selector: `MemberExpression[computed=true][property.value=0]${split}`,
    message: DATE_SPLIT_MESSAGE,
  })),
  // `parts.at(0)` and `parts.shift()`
  ...SPLIT_ON_T_SELECTORS.flatMap((split) => {
    // EVERY attribute moves under `callee`, not just the first. Anchoring this
    // with `^` rewrote only the leading one and left `[object.arguments.0…]`
    // behind, so both arms silently matched nothing — which is why the fixture
    // probe lints each spelling rather than trusting the string surgery.
    const onSplit = split.replace(/\[object\./g, "[callee.object.");
    return [
      {
        selector: `CallExpression[callee.property.name="at"][arguments.0.value=0]${onSplit}`,
        message: DATE_SPLIT_MESSAGE,
      },
      {
        selector: `CallExpression[callee.property.name="shift"]${onSplit}`,
        message: DATE_SPLIT_MESSAGE,
      },
    ];
  }),
];

// The truncation ASSEMBLED INSIDE ONE FUNCTION rather than written as a single
// expression:
//
//   export function formatDocumentDate(date: Date): string {
//     const iso = date.toISOString();
//     return iso.slice(0, 10);
//   }
//
// Every arm above anchors the cut on its receiver, and here the receiver is a
// plain identifier, so all of them missed it — and so did the census test, whose
// wrapper-following only recognised delegations to a canonical encoder, not a
// body that writes the truncation itself. This is `formatDate` rebuilt one step
// at a time, which is exactly the shape that hid roughly eighteen Xero document
// dates, so it is matched at the level where both halves are visible: the
// function.
//
// BOTH HALVES ARE PINNED TIGHTLY, and the loose version was measured before this
// one was written. Requiring only "a function that calls toISOString somewhere
// and slices ten characters somewhere" reported two real files —
// `email-failure-review.ts` and `token-email-recovery.ts` — where the
// `toISOString()` calls serialise full timestamps into a response object and the
// `.slice(0, 10)` is an ARRAY take-ten of the ten most recent rows. Those are not
// the same expression and never were.
//
// So the ISO half must be STORED (`const iso = d.toISOString()`, or assigned to
// an existing binding), and the cut must be taken on a plain IDENTIFIER. That is
// the shape of the escape and not the shape of the coincidence.
const ISO_STORED_IN_A_BINDING = [
  'VariableDeclarator[init.callee.property.name=/^(toISOString|toJSON)$/]',
  'AssignmentExpression[right.callee.property.name=/^(toISOString|toJSON)$/]',
];

const CUT_TEN_OFF_A_BINDING =
  'CallExpression[callee.property.name=/^(slice|substring|substr)$/][callee.object.type="Identifier"][arguments.0.value=0][arguments.1.value=10]';

const NO_TRUNCATION_ASSEMBLED_IN_A_WRAPPER = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
].flatMap((fn) =>
  ISO_STORED_IN_A_BINDING.map((stored) => ({
    selector: `${fn}:has(${stored}):has(${CUT_TEN_OFF_A_BINDING})`,
    message:
      "INV-DATE-019: This function stores a toISOString()/toJSON() result and then cuts ten characters off a binding, which is a hand-written date-only encoding assembled in two steps (#2684). One expression or two, it is the same duplication — and splitting it across a local is precisely what hid the last one from both this rule and the census. Call formatDateOnly / formatMonthOnly from @/lib/date-only for a DATE-ONLY value (INV-DATE-010), formatDateOnlyForTimeZone for a real instant (#2697), or dateOnlyFromIsoString when what you hold is already an ISO string.",
  })),
);

// The encoding assembled from UTC CLOCK-FACE PARTS, which produces the identical
// `yyyy-MM-dd` (or `yyyy-MM`) string with no ISO spelling anywhere in it:
//
//   `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
//
// This was LIVE IN THREE FILES when the rule was written and no arm could see
// any of them — `previousMonthKey` in `finance-sync-health.ts` (in a file this
// very branch was already editing), and the EXPORTED `formatDateKey` and
// `monthKey` helpers on the kiosk week strip and the occupancy calendar. All
// three are migrated; the selector is what stops a fourth.
//
// A template literal interpolating BOTH the UTC year and the UTC month or day is
// a date key and nothing else. Reading one part alone — `getUTCFullYear()` for a
// season label, `getUTCMonth()` for arithmetic — is untouched, which is why this
// costs no false positives on the tree today.
const NO_DATE_ONLY_FROM_UTC_PARTS = {
  selector:
    'TemplateLiteral:has(CallExpression[callee.property.name="getUTCFullYear"]):has(CallExpression[callee.property.name=/^getUTC(Month|Date)$/])',
  message:
    "INV-DATE-019: Do not assemble a date key from UTC clock-face parts (#2684). `${d.getUTCFullYear()}-${...getUTCMonth() + 1...}` is the same hand-written encoding as toISOString().slice(0, 10), written in a spelling no date census recognises. Use formatDateOnly / formatMonthOnly from @/lib/date-only for a DATE-ONLY value (INV-DATE-010), or formatDateOnlyForTimeZone for a real instant (#2697). Building a Date FROM parts is the opposite direction and is fine — this is about reading one back out.",
};

const DATE_ONLY_ENCODING_RESTRICTIONS = [
  ...NO_HAND_WRITTEN_DATE_ONLY_TRUNCATION,
  NO_ISO_DATE_REPLACE,
  ...NO_ISO_DATE_SPLIT_ON_T,
  ...NO_TRUNCATION_ASSEMBLED_IN_A_WRAPPER,
  NO_DATE_ONLY_FROM_UTC_PARTS,
];

// #2264, one hole later — an `Intl.DateTimeFormat` built with NO `timeZone`.
//
// The rule above bans `toLocaleDateString()` because it renders in the VIEWER's
// zone, and the message sends the author to "a module-level Intl.DateTimeFormat
// pinned to APP_LOCALE + APP_TIME_ZONE". An unpinned `new Intl.DateTimeFormat()`
// has exactly the defect the ban exists for and is clean under every arm of it,
// which makes it the obvious workaround for anyone the rule inconveniences —
// and `new Intl.DateTimeFormat("en-CA").format(d)` is worse than the general
// case, because `en-CA` numeric IS `yyyy-MM-dd`. That is a date-only ENCODING
// taken from the viewer's calendar: a lodge night rendered in Vancouver comes
// out a day early, silently, with no ISO spelling and no `toLocale*` call for
// either guard to catch.
//
// Every `new Intl.DateTimeFormat` in `src/` already passes a `timeZone`, so this
// costs nothing today. A formatter that genuinely must follow the reader's own
// clock passes `timeZone: undefined` explicitly, which says so in the source.
const NO_UNZONED_INTL_DATE_TIME_FORMAT = {
  selector:
    'NewExpression[callee.object.name="Intl"][callee.property.name="DateTimeFormat"]:not(:has(Property[key.name="timeZone"]))',
  message:
    "INV-DATE-015: An Intl.DateTimeFormat with no `timeZone` renders in the VIEWER's zone, which is the whole defect the toLocaleDateString ban exists for (#2264) — and `en-CA` numeric is `yyyy-MM-dd`, so an unpinned one is a date-only encoding taken from the reader's calendar rather than the club's. Since CT-2 (#2990) no call site should be building one at all: use a named house shape from @/lib/club-time, which owns the only formatter factory in the tree and memoises it by zone. A formatter that really must follow the reader's clock passes `timeZone: undefined` explicitly.",
};

const ZONED_FORMATTER_RESTRICTIONS = [NO_UNZONED_INTL_DATE_TIME_FORMAT];

// ---------------------------------------------------------------------------
// CT-6 (#2991) — the two recurrence paths the epic left mechanically open.
// ---------------------------------------------------------------------------
//
// The three arms above cover the RENDERING escapes (`toLocale*`, an unzoned
// `Intl.DateTimeFormat`) and the date-only ENCODING escapes. Two classes were
// still guarded by nothing at all, and each is the shape a whole CT-4 group was
// spent removing:
//
//   * reading a `Date` back through its HOST clock face — `getFullYear()`,
//     `getMonth()`, `getDate()` — which answers in the container's zone rather
//     than the club's, so west of Greenwich a stored lodge night reads a day
//     early. `#3082` (a boundary birthday selecting the wrong price band) and
//     `#3100` (a stay expander that did not terminate) were both this;
//   * taking the ENVIRONMENT's zone as civil-time authority, either by reading
//     `process.env.TZ` directly or by importing `APP_TIME_ZONE`. Since CT-1
//     (#2989) the club's zone is the persisted `ClubTimeSettings.timeZone`
//     (`INV-CONFIG-002`); `TZ` seeds that row at setup and has no further say.
//
// Both are expressed as `no-restricted-syntax` arms rather than as
// `no-restricted-imports`, deliberately. Flat config REPLACES a rule's options
// rather than merging them, and `src/lib/xero-*.ts` already sets
// `no-restricted-imports` for its own facade rule — so an import-based guard
// here would be silently lifted for exactly the Xero modules that date
// financial documents. Everything mandatory lives in ONE array, which is the
// architecture the fold below already insists on.

const HOST_CLOCK_FACE_READERS =
  "^(getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds)$";
const HOST_CLOCK_FACE_WRITERS =
  "^(setFullYear|setMonth|setDate|setHours|setMinutes|setSeconds)$";

const HOST_CLOCK_FACE_MESSAGE =
  "INV-DATE-014 / INV-CONFIG-002: This reads or writes a Date through the HOST's clock face, so it answers in whatever zone the container happens to run in (CT-6, #2991). A `@db.Date` lodge night is UTC midnight, and west of Greenwich `.getDate()` on one returns the PREVIOUS day — that is #3082 (a boundary birthday priced a year young) and #3100 (a stay expander that never terminated). Calendar arithmetic on a stay day: addDaysDateOnly / addMonthsDateOnly / eachDateOnlyInRange / countNightsDateOnly from @/lib/date-only, which are UTC-based and zone-free. A civil date or time from a real instant: clubCalendarDateOf(instant, zone) or a house shape from @/lib/club-time. A DURATION: subtract milliseconds from the instant, which is what `setDate(getDate() - n)` was approximating and gets wrong by an hour across DST. The getUTC* readers are untouched — they name their frame.";

// Both spellings a member access can reach these through, matching the
// encoding arm above: `d.getDate()` reads `property.name`, `d["getDate"]()`
// reads `property.value`. The computed form is the documented escape from every
// syntactic rule in this file, so a new rule should close it on the way in
// rather than record it as a known limitation.
const NO_HOST_CLOCK_FACE = [
  `CallExpression > MemberExpression.callee[property.name=/${HOST_CLOCK_FACE_READERS}/]`,
  `CallExpression > MemberExpression.callee[property.value=/${HOST_CLOCK_FACE_READERS}/]`,
  `CallExpression > MemberExpression.callee[property.name=/${HOST_CLOCK_FACE_WRITERS}/]`,
  `CallExpression > MemberExpression.callee[property.value=/${HOST_CLOCK_FACE_WRITERS}/]`,
].map((selector) => ({ selector, message: HOST_CLOCK_FACE_MESSAGE }));

const ENVIRONMENT_ZONE_MESSAGE =
  "INV-CONFIG-002: The environment's timezone is not the club's (CT-1, #2989; CT-6, #2991). `TZ` / `NEXT_PUBLIC_TZ` SEED the persisted `ClubTimeSettings.timeZone` row at setup and have no say afterwards, so a business or display decision taken from them follows whichever container the process happens to be in. Server component or route: clubTimeZone() / clubTime() from @/lib/club-time/server, which is request-scoped and memoised. A cron tick or a CLI, which `server-only` refuses: readClubTimeZoneOutsideRequest() from @/lib/club-time-zone-runtime. A client component: receive the zone as data through ClubTimeProvider — the browser never decides it. @/lib/date-only is the last compatibility adapter this issue retires, and it no longer DEFAULTS a zone: #3123 deleted its six `= APP_TIME_ZONE` defaults, so every helper there now demands one from its caller. The rendering adapter beside it, @/lib/nzst-date, is already deleted (#3123). Do not add a caller, and do not build a replacement.";

// `process.env.TZ` and `process.env.NEXT_PUBLIC_TZ`, read anywhere but the two
// modules whose job is to read them once.
//
// THREE SPELLINGS, because a syntactic rule that closes only the obvious one is
// a rule with a documented way round it. The dotted form was all this arm
// matched at first, and a review lens measured that `process.env["TZ"]` and
// `const { TZ } = process.env` both walked straight past it — while the census
// beside it looked for `APP_TIME_ZONE` and could not see them either, so for
// those two spellings the "two instruments" claim was untrue. Both neighbouring
// arms in this file already close their computed twin on principle
// (`NO_HOST_CLOCK_FACE` has a `property.value` pair, `NO_ENVIRONMENT_ZONE_IMPORT`
// an `imported.value` one); this now matches them. Live population is zero, so
// this costs nothing today and is purely about what may be written next.
const NO_ENVIRONMENT_ZONE_ENV_READ = [
  // `process.env.TZ`
  'MemberExpression[object.object.name="process"][object.property.name="env"][property.name=/^(TZ|NEXT_PUBLIC_TZ)$/]',
  // `process.env["TZ"]`
  'MemberExpression[object.object.name="process"][object.property.name="env"][property.value=/^(TZ|NEXT_PUBLIC_TZ)$/]',
  // `const { TZ } = process.env`, and its quoted-key form
  'VariableDeclarator[init.object.name="process"][init.property.name="env"] > ObjectPattern > Property[key.name=/^(TZ|NEXT_PUBLIC_TZ)$/]',
  'VariableDeclarator[init.object.name="process"][init.property.name="env"] > ObjectPattern > Property[key.value=/^(TZ|NEXT_PUBLIC_TZ)$/]',
].map((selector) => ({ selector, message: ENVIRONMENT_ZONE_MESSAGE }));

// Importing the environment zone by name. `@/config/operational` exports it as
// a plain string, so nothing downstream of the import can tell it from a club
// zone — which is how 133 call sites came to take it as a default without one
// review noticing.
const NO_ENVIRONMENT_ZONE_IMPORT = [
  'ImportDeclaration[source.value="@/config/operational"] > ImportSpecifier[imported.name="APP_TIME_ZONE"]',
  'ImportDeclaration[source.value="@/config/operational"] > ImportSpecifier[imported.value="APP_TIME_ZONE"]',
].map((selector) => ({ selector, message: ENVIRONMENT_ZONE_MESSAGE }));

const HOST_CLOCK_RESTRICTIONS = [...NO_HOST_CLOCK_FACE];

const ENVIRONMENT_ZONE_RESTRICTIONS = [
  ...NO_ENVIRONMENT_ZONE_ENV_READ,
  ...NO_ENVIRONMENT_ZONE_IMPORT,
];

// ---------------------------------------------------------------------------
// CT-6 (#2991) — the class no syntactic guard above can see.
// ---------------------------------------------------------------------------
//
// The host-clock arm matches `.getDate()` where it is WRITTEN. `date-fns` does
// the identical read inside `node_modules`, so a file that imports `format` or
// `startOfMonth` has every one of that arm's defects and is clean under every
// selector in this file. That is not a theory — measured on this runtime, with
// one `@db.Date` lodge night stored at `2026-09-01T00:00:00.000Z`:
//
//   format(night, "yyyy-MM-dd")   UTC -> "2026-09-01"   Denver -> "2026-08-31"
//   startOfMonth(night)           UTC -> 1 Sep 00:00Z   Denver -> 1 AUG 06:00Z
//   addDays(26 Sep night, 1)      Auckland -> 2026-09-26T23:00:00.000Z, an hour
//                                 short of UTC midnight, because it crossed the
//                                 27 September daylight-saving transition
//
// So a stay day renders a day early west of Greenwich, a report bucket lands in
// the wrong MONTH, and a `@db.Date` range bound built by adding a day falls on
// the wrong side of a stored night on one weekend a year.
//
// Not every export is a hazard: `formatDistanceToNow` measures a DURATION and
// `differenceInCalendarDays` between two UTC-midnight values shifts both ends
// equally, so both are zone-independent here. The ban is on the MODULE anyway,
// because which exports are safe is a judgement that belongs in a reviewed
// allowlist entry rather than in a regular expression somebody widens later.

//
// SEVEN SPELLINGS, and the RE-EXPORT is the one that mattered most: a single
// file writing `export { addDays } from "date-fns"` makes every downstream
// importer clean under every selector in this file, so one line would have
// re-opened the class wholesale. A review lens found four spellings walking
// past the first three selectors; all four are closed here.
//
// WHAT IS STILL OPEN, said plainly rather than left to be discovered. A
// dynamic import whose specifier is a VARIABLE — `const m = "date-fns";
// await import(m)` — is not statically decidable and no selector can reach it,
// and neither can a `require` assembled from a template. That is the same
// residue every syntactic rule in this file carries; the census beside this one
// is the second instrument, and `date-fns-tz` is deliberately not a dependency
// so there is no sibling package to smuggle it in through.
const NO_DATE_FNS = [
  'ImportDeclaration[source.value="date-fns"]',
  'ImportDeclaration[source.value=/^date-fns\\//]',
  'CallExpression[callee.name="require"][arguments.0.value="date-fns"]',
  'CallExpression[callee.name="require"][arguments.0.value=/^date-fns\\//]',
  // `export { addDays } from "date-fns"` and `export * from "date-fns"`
  'ExportNamedDeclaration[source.value="date-fns"]',
  'ExportNamedDeclaration[source.value=/^date-fns\\//]',
  'ExportAllDeclaration[source.value="date-fns"]',
  'ExportAllDeclaration[source.value=/^date-fns\\//]',
  // `await import("date-fns")`
  'ImportExpression[source.value="date-fns"]',
  'ImportExpression[source.value=/^date-fns\\//]',
].map((selector) => ({
  selector,
  message:
    "INV-DATE-014 / INV-CONFIG-002: `date-fns` reads and writes the HOST's clock face, so it carries every defect the host-clock ban above exists for while being invisible to it (CT-6, #2991). Measured on a `@db.Date` lodge night at UTC midnight: `format(night, \"yyyy-MM-dd\")` answers the PREVIOUS day west of Greenwich, `startOfMonth(night)` lands in the previous MONTH, and `addDays(night, 1)` returns an hour short of UTC midnight across a daylight-saving transition. Calendar arithmetic on stay days: addCalendarDays / addCalendarMonths / startOfCalendarMonth / eachCalendarDate / countClubNights from @/lib/club-time, which are zone-free. Rendering: formatClubDate for a calendar day, formatClubInstant* for a real instant. A relative DURATION (`formatDistanceToNow`) is genuinely zone-free — if that is all you need, say so on DATE_FNS_ADAPTERS rather than importing the module here.",
}));

const DATE_FNS_RESTRICTIONS = [...NO_DATE_FNS];

/**
 * The files still importing `date-fns`, each with what it uses and why it has
 * not moved. A RATCHET, like `ENVIRONMENT_ZONE_ADAPTERS`: it only shrinks, and
 * `club-time-boundary-guard.test.ts` refuses to let it grow.
 *
 * None of these is a new decision by CT-6. Two are the admin report
 * bucket/date-series residual #2870's ledger already names; the rest are
 * relative-duration hints and chart tick labels.
 */
const DATE_FNS_ADAPTER_FILES = [
  "src/app/(admin)/admin/members/_components/xero-groups-refresh-hint.tsx",
  "src/app/(admin)/admin/reports/page.tsx",
  "src/app/(admin)/admin/reports/_components/report-charts.tsx",
  "src/components/admin/member-password-action-button.tsx",
  "src/lib/admin-dataset-reset-state.ts",
  "src/lib/admin-reports.ts",
  "src/lib/cron-hut-leader-auto-assign.ts",
];

export const DATE_FNS_ADAPTERS = [
  {
    file: "src/app/(admin)/admin/members/_components/xero-groups-refresh-hint.tsx",
    uses: "formatDistanceToNow",
    reason:
      "A relative DURATION (\"3 hours ago\") for a refresh hint, which is zone-independent: it is the gap between two instants and no civil date is derived from it.",
  },
  {
    file: "src/components/admin/member-password-action-button.tsx",
    uses: "formatDistanceToNow",
    reason:
      "The same relative-duration hint on a password action, zone-independent for the same reason.",
  },
  {
    file: "src/app/(admin)/admin/reports/page.tsx",
    uses: "format",
    reason:
      "The admin report date-series surface #2870's ledger carries as an open residual. Migrating it is a report-shape change, not a formatter swap, so it is scoped there rather than re-scoped here.",
  },
  {
    file: "src/app/(admin)/admin/reports/_components/report-charts.tsx",
    uses: "format",
    reason:
      "Chart tick labels for the same surface and the same residual; they must agree with the series that feeds them, so the two move together or not at all.",
  },
  {
    file: "src/lib/admin-reports.ts",
    uses: "addDays, addMonths, addWeeks, differenceInCalendarDays, endOfMonth, endOfWeek, format, isAfter, startOfMonth, startOfWeek",
    reason:
      "The report BUCKETING itself, and the largest single remaining escape hatch in the tree: ten host-local helpers deciding which week or month a booking falls in. #2870's ledger names it as the admin-report bucket/date-series residual. CT-6 measured it rather than moved it, because a bucket boundary change alters what every historical report says.",
  },
  {
    file: "src/lib/admin-dataset-reset-state.ts",
    uses: "endOfMonth, format, startOfMonth, subMonths",
    reason:
      "Month windows for the dataset-reset screen, sharing the report residual's shape and blocked on the same decision about bucket boundaries.",
  },
  {
    file: "src/lib/cron-hut-leader-auto-assign.ts",
    uses: "addDays, eachDayOfInterval",
    reason:
      "The lookahead window over which the job scans for uncovered nights. It reads a club `today` from the kernel and then steps it with host-local helpers, so the LAST day of a long lookahead can shift by one across a daylight-saving transition. Narrow and inside a cron, but real; it is the cheapest of the seven to move and the one to take next.",
  },
];

/**
 * The modules still allowed to name the ENVIRONMENT's zone, each with the
 * reason it is not simply a defect. Exported so
 * `club-time-boundary-census.test.ts` reads this record rather than keeping a
 * copy that drifts out of step with the config that ships.
 *
 * THIS LIST IS A RATCHET AND IT ONLY SHRINKS. Two entries are structural — the
 * environment has to be read somewhere for the setup wizard to offer it — and
 * the rest are callers CT-6 measured and could not migrate without threading a
 * club zone through a surface belonging to another issue. Each names what is
 * blocking it. Adding a file here re-opens the class the guard exists to close,
 * so the census test asserts the list has not grown.
 *
 * IT SHRANK AGAIN IN #3126, and by the route this list prefers. The last entry
 * to leave, `src/lib/member-merge-field-kinds.ts`, was excused so a client
 * component could keep a `= APP_TIME_ZONE` DEFAULT on its renderer — and the
 * exemption written for a READ was quietly covering a default, which is a
 * different and worse thing. Deleting the default (`INV-SSOT-003`) left the file
 * naming the environment nowhere, so the entry had outlived its cause and went
 * with it. The new `AUTHORITY_DEFAULT_RESTRICTIONS` arm is deliberately NOT
 * droppable by any block, so no future entry here can cover a default again.
 *
 * IT HAD ALREADY SHRUNK ONCE BEFORE THAT, and how is worth recording:
 * `src/lib/nzst-date.ts`
 * was the rendering adapter and the last module that BOUND the environment zone
 * at module load. #3123 did not migrate it — it DELETED it, once every
 * production caller had moved to the kernel. An entry leaving this list by way
 * of the file being deleted is the intended end state, not a special case, and
 * `club-time-boundary-guard.test.ts` fails on an entry naming a file that no
 * longer exists precisely so the two cannot drift apart.
 *
 * `src/lib/date-only.ts` IS NOT HERE, AND NO LONGER NEEDS TO BE ANYWHERE. It has
 * a block of its own further down, which used to drop this group as well because
 * six of its helpers defaulted their `timeZone` to `APP_TIME_ZONE`. #3123 removed
 * those defaults and the import, so that block drops only the ENCODING group now
 * and these arms reach the file like any other. Were it ever to need this group
 * again it would still belong in its own block rather than on this list: listing
 * it twice would give it two matching blocks, the later of which silently wins.
 */
const ENVIRONMENT_ZONE_ADAPTER_FILES = [
  "src/config/operational.ts",
  "src/lib/club-time-zone-env.ts",
  "src/lib/ai-assistant-usage.ts",
  "src/lib/ai-diagnostics-usage.ts",
  "src/lib/induction-display.ts",
];

export const ENVIRONMENT_ZONE_ADAPTERS = [
  {
    file: "src/config/operational.ts",
    reason:
      "STRUCTURAL. The one read of `process.env.TZ` in the tree, and the definition of APP_TIME_ZONE itself. CT-1 (#2989) kept it as the SEED the setup wizard offers and the self-heal step backfills the persisted row from, so it has to exist somewhere.",
  },
  {
    file: "src/lib/club-time-zone-env.ts",
    reason:
      "STRUCTURAL. CT-1's seed reader (#2989): exactly one module decides what the environment claims, and `client-server-boundary-census.test.ts` already keeps it out of the browser bundle.",
  },
  {
    file: "src/lib/ai-assistant-usage.ts",
    reason:
      "An internal metering month key for the AI page-help budget, not a club-facing civil-time answer. Migrating it needs the club zone inside a module a client bundle reaches; tracked with the five below.",
  },
  {
    file: "src/lib/ai-diagnostics-usage.ts",
    reason:
      "The same internal metering month key for the diagnostics budget, in the same shape and blocked on the same thing.",
  },
  {
    file: "src/lib/induction-display.ts",
    reason:
      "A module-level formatter on a module deliberately split so CLIENT components can import it (its own header says so), so it cannot call `clubTimeZone()` — the zone has to arrive as data through ClubTimeProvider, which is a change to every caller rather than to this file.",
  },
];

/**
 * The three `toLocale*` DATE-RENDERING arms (#2256, #2264), as a NAMED array
 * rather than three literals repeated in four blocks.
 *
 * A block lifts these by omitting them, which is invisible: nothing distinguishes
 * "this block does not need the rendering arms" from "somebody dropped them".
 * Named here, `DATE_GUARD_ARMS.rendering` lets `date-only-encoding-guard.test.ts`
 * assert that a given path still resolves to all three — which is what pins
 * `src/lib/date-only.ts` still carrying the DATE-rule exemption its own block
 * grants it, and nothing else. It also pinned `src/lib/nzst-date.ts` losing its
 * exemption in CT-2 (#2990) — a removal no test could see before — until #3123
 * deleted that file and the pin with it.
 */
const DATE_RENDERING_RESTRICTIONS = [
  NO_BARE_TO_LOCALE_DATE_STRING,
  NO_BARE_TO_LOCALE_TIME_STRING,
  NO_BARE_TO_LOCALE_STRING,
];

/**
 * The date arm families as bare selector strings, for
 * `date-only-encoding-guard.test.ts` — the mirror of `MONEY_GUARD_ARMS` below.
 *
 * The suite resolves this config through ESLint's own
 * `calculateConfigForFile()` at the shared production roster and checks the
 * resolved rule still carries every selector each family declares. It reads them
 * from HERE rather than from a copy, because a copy passes happily while the
 * config that ships has dropped the arm.
 */
/**
 * The CT-6 (#2991) arm families, as bare selector strings, for
 * `club-time-boundary-guard.test.ts` — the same mirror `DATE_GUARD_ARMS`
 * provides for the #2684 families.
 *
 * Read from HERE rather than from a copy in the suite: a copy passes happily
 * while the config that ships has dropped the arm, which is the exact failure
 * the roster audit below exists to catch.
 */
export const CLUB_TIME_GUARD_ARMS = {
  hostClock: HOST_CLOCK_RESTRICTIONS.map((entry) => entry.selector),
  environmentZone: ENVIRONMENT_ZONE_RESTRICTIONS.map((entry) => entry.selector),
  dateFns: DATE_FNS_RESTRICTIONS.map((entry) => entry.selector),
};

export const DATE_GUARD_ARMS = {
  encoding: DATE_ONLY_ENCODING_RESTRICTIONS.map((entry) => entry.selector),
  zonedFormatter: ZONED_FORMATTER_RESTRICTIONS.map((entry) => entry.selector),
  rendering: DATE_RENDERING_RESTRICTIONS.map((entry) => entry.selector),
};

// ---------------------------------------------------------------------------
// INV-SSOT-003 (#3126) — no default on a parameter that resolves a CLUB
// authority.
// ---------------------------------------------------------------------------
//
// A parameter default answers for every caller that did not pass one, and it
// answers SILENTLY. When the value is a club authority with a second source,
// the default decides which source wins for the whole tree — and it is never
// the club's. `getTodayDateOnly(timeZone = APP_TIME_ZONE)` was one line; it took
// 81 call sites across 52 files with it, and policing them needed a hand-built
// census that counts call sites by walking parentheses and pins five exact
// numbers. EVERY BIT OF THAT MACHINERY EXISTED BECAUSE THE DEFAULT EXISTED.
//
// WHY THIS IS A SEPARATE ARM FROM `NO_ENVIRONMENT_ZONE_*` ABOVE, which already
// bans naming the environment's zone at all. That group is LIFTED for the files
// on `ENVIRONMENT_ZONE_ADAPTER_FILES`, because an adapter has a reason to read
// the environment — and a lifted group lifts the default with it. That is not a
// theory either: `src/lib/date-only.ts` held its six `= APP_TIME_ZONE` defaults
// legally for months inside a block of its own, and
// `src/lib/member-merge-field-kinds.ts` held a seventh on the shared adapter
// block until #3126 deleted it. THIS ARM IS ON `ALWAYS_RESTRICTED_IN_SRC` AND NO
// BLOCK LIFTS IT. Reading the environment's zone is a reviewed exception;
// handing it to callers as a default is not, in any file.
//
// WHICH NAMES ARE ON THE LIST. `INV-SSOT-003` names them, and this array is that
// rule's implementation rather than a second opinion about it: the
// `@/config/operational` exports naming a club-facing authority —
// `APP_TIME_ZONE` and `APP_LOCALE` — plus the environment variables behind the
// zone, `TZ` and `NEXT_PUBLIC_TZ`.
//
// The zone is the measured case. The club's civil time is the
// `ClubTimeSettings.timeZone` row (`INV-CONFIG-002`, CT-1 #2989), and
// `TZ` / `NEXT_PUBLIC_TZ` / `APP_TIME_ZONE` are the ENVIRONMENT's claim, which
// seeds that row at setup and has no say afterwards — two sources, and the
// default silently picked the wrong one.
//
// THE LOCALE IS ON THE LIST AHEAD OF ITS SECOND SOURCE, and that is worth saying
// out loud rather than leaving a reader to infer a criterion the list does not
// satisfy. There is no persisted club locale in `schema.prisma` today, so
// nothing yet competes with `APP_LOCALE`, and its live default population is
// zero. It is banned anyway because it is the same KIND of value — how this club
// answers a display question — and listing it while the population is zero costs
// nothing, where adding it after a club-locale setting ships would cost a
// migration and a census of whatever had been written in the meantime. That is
// the cheap direction to be wrong in.
//
// WHAT IS DELIBERATELY NOT BANNED, because stating the boundary is half of this
// arm's value:
//
//   * `APP_CURRENCY` and `APP_STRIPE_CURRENCY`. `src/lib/stripe.ts` carries two
//     live `currency = APP_STRIPE_CURRENCY` parameter defaults, on
//     `chargePaymentMethod` and `createPaymentIntent`, and they are CORRECT
//     rather than tolerated. THE REASON IS COST, NOT KIND, and it is worth
//     saying precisely because an earlier draft of this comment claimed the
//     currency was single-sourced today and it is not: two admin display
//     formatters hardcode `currency: "NZD"` rather than reading `APP_CURRENCY`,
//     and `schema.prisma` gives `PaymentTransaction.currency` a `"nzd"` column
//     default. Those are a separate, pre-existing defect that this arm does not
//     address and is not the right instrument for. What IS true, and is what
//     the exclusion rests on: no persisted club-currency SETTING competes with
//     `APP_CURRENCY`, so there is no wrong-source-of-two to pick — and every one
//     of the eight live call sites, in eight distinct modules, relies on the
//     default rather than passing a currency, so deleting it would spread the
//     `@/config/operational` import to eight more modules without touching
//     either hardcoded formatter. That is strictly worse for single source of
//     truth than leaving the read in the one boundary that owns the Stripe wire
//     format. THE DAY A PERSISTED CLUB-CURRENCY SETTING EXISTS, both names join
//     the list above and `stripe.ts` becomes a real violation. That sentence is
//     the ratchet; without it the exclusion rots into a permanent hole. Being a
//     cost argument rather than a kind argument — the currency is as club-facing
//     as the locale — it is the one exclusion here a reader should expect to be
//     revisited.
//   * `process.env.<anything else>` as a default, which `INV-SSOT-003`'s prose
//     describes more broadly than this arm implements. MEASURED, rather than
//     assumed, and re-measured for #3126's review because the first measurement
//     was wrong: there are SEVEN live instances in this tree, not the three an
//     earlier draft of this comment named. SIX default the whole environment as
//     an injection seam — `src/lib/admin-cron-health.ts` twice,
//     `src/lib/email-delivery.ts`, `src/lib/environment-role-declaration.ts`,
//     `src/lib/ignored-email-env.ts` and `src/lib/xero-config.ts` — and ONE
//     defaults a single variable, `isValidCronSecret(expected =
//     process.env.CRON_SECRET)` in `src/lib/cron-auth.ts`. The conclusion is
//     unchanged and in fact stronger: a seam that takes `process.env` so a test
//     can pass a fake is not a default picking the wrong one of two sources, so
//     a broad ban would be seven false positives out of seven matches. One
//     nuance rather than a blanket claim of no second source:
//     `environment-role-declaration.ts` is governed by `INV-CONFIG-003`, under
//     which the DATABASE may force the safer environment role — a second source
//     by this invariant's own definition, though what it defaults is the seam
//     and not the role. A guard that is wrong every time it fires trains its
//     reader to switch it off, and #3126's own risk note says the one live
//     hazard here is an arm too broad to live with. So the environment half of
//     the arm is scoped to the variables behind the zone. Widening it later is a
//     decision with seven named call sites attached, which is the shape a
//     decision should have.
//   * A default that CALLS a club authority resolver — `= await clubTimeZone()`,
//     `= readClubTimeZoneOutsideRequest()`. Those return the CLUB's answer, so
//     they are not this defect at all. Population zero; recorded so a later
//     reader knows it was considered rather than missed.
//   * A `??` or `||` fallback in a function BODY — `const tz = opts.tz ??
//     APP_TIME_ZONE`. Said plainly as a known limit: it is the same hazard
//     written differently, and it is out of scope because banning it would reach
//     a large legitimate population at genuine boundaries. The second instrument
//     is `ssot-authority-default-guard.test.ts`, which censuses the source
//     directly.
const CLUB_AUTHORITY_DEFAULT_NAMES = "^(APP_TIME_ZONE|APP_LOCALE)$";
const CLUB_AUTHORITY_DEFAULT_ENV = "^(TZ|NEXT_PUBLIC_TZ)$";

const AUTHORITY_DEFAULT_MESSAGE =
  "INV-SSOT-003: This parameter DEFAULTS to a club authority, so it answers for every caller that did not pass one — and it answers from the environment rather than from the club. The club's civil time is the persisted `ClubTimeSettings.timeZone` row (`INV-CONFIG-002`, CT-1 #2989); `APP_TIME_ZONE`, `APP_LOCALE`, `TZ` and `NEXT_PUBLIC_TZ` are the ENVIRONMENT's claim, which seeds that row at setup and has no say afterwards. THE REMEDY IS TO DELETE THE DEFAULT and let the compiler enumerate the call sites: a required argument beats a lint rule, one exported symbol beats an allowlist, and a deleted default beats a counted ratchet. That is a worked precedent rather than a proposal — `getTodayDateOnly(timeZone = APP_TIME_ZONE)` cost a hand-counted census of every call site that left the zone unstated, ratcheted down lane by lane, until #3123 deleted the six `= APP_TIME_ZONE` defaults from @/lib/date-only and turned the whole class into a compile error. Those figures are recorded in exactly one place, `club-time-escape-hatch-census.test.ts`, and a number restated in prose is a number that drifts. Then pass the club's zone in: clubTimeZone() / clubTime() from @/lib/club-time/server in a server component or route, readClubTimeZoneOutsideRequest() from @/lib/club-time-zone-runtime in a cron tick or a CLI, and ClubTimeProvider data in a client component, which never decides it.";

// `AssignmentPattern` is the default in EVERY position it can be written, which
// is why the arm anchors on it rather than on a function's parameter list: a
// plain parameter default (`f(tz = APP_TIME_ZONE)`), an options-object property
// default (`f({ tz = APP_TIME_ZONE })` — the shape this codebase actually
// writes), an array-destructuring default and a destructured default inside a
// body are one node type and one defect.
//
// TWO FORMS PER SHAPE, AND THE PAIRING IS THE WHOLE DESIGN.
//
// The first arm of each pair is a FIELD anchor — `> Identifier.right`, which
// matches only when the authority IS the default. The second is a DESCENDANT of
// the field — `> .right Identifier`, where `> .right` selects whatever node
// occupies the `right` field whatever its type, and the descendant combinator
// then finds the authority anywhere beneath it.
//
// The pair cannot double-report, and that is a property of the descendant
// combinator rather than of the node types involved: `A B` in esquery EXCLUDES
// self, so when the authority is the field itself only the first arm matches,
// and when it is wrapped only the second can. That matters because
// `f({ tz = APP_TIME_ZONE } = {})` nests an inner `AssignmentPattern` inside an
// outer one, and #2685 already paid for reporting one node three times at one
// line:column. The outer pattern's `right` is the `{}`, which contains nothing;
// the inner pattern's `right` is the authority itself. One report. Measured, and
// asserted for every spelling in `ssot-authority-default-guard.test.ts`.
//
// WHY NOT ENUMERATE THE WRAPPERS. The arm used to name `LogicalExpression` and
// `ConditionalExpression` explicitly, and six spellings walked past it:
// `= APP_TIME_ZONE as string`, `= process.env.TZ!`, `= APP_TIME_ZONE satisfies
// string`, `` = `${APP_TIME_ZONE}` ``, `= String(APP_TIME_ZONE)` and
// `= (0, APP_TIME_ZONE)`. The `as` and `!` spellings are not exotic — they are
// what the TYPE SYSTEM forces. `process.env.TZ` is `string | undefined`, so on
// the `timeZone: string` parameter this codebase writes everywhere the defect
// CANNOT be spelled `= process.env.TZ` at all; of the three spellings that
// compile, the enumerated arm closed one. Enumeration is whack-a-mole and the
// next TypeScript expression node re-opens it, so the wrapper list is gone and
// `> .right` closes the class instead.
//
// WHAT THIS ARM STILL CANNOT SEE, and where it is covered instead. A
// `no-restricted-syntax` selector has no symbol table, so an authority renamed
// on the way in — `import { APP_TIME_ZONE as CLUB_ZONE }`, `const { TZ } =
// process.env`, `const env = process.env` — is invisible to it, and the group
// that would otherwise catch such a read is LIFTED in exactly the files most
// likely to write one. That half is the second instrument's:
// `ssot-authority-default-guard.test.ts` resolves those bindings from the source
// and censuses `src/`, `scripts/` and `prisma/` for them. The same file states
// the two spellings neither instrument closes. So do not answer a new
// indirection by adding a selector here — a selector cannot resolve a name.
const NO_CLUB_AUTHORITY_DEFAULT = [
  // `f(tz = APP_TIME_ZONE)` — the authority IS the default.
  `AssignmentPattern > Identifier.right[name=/${CLUB_AUTHORITY_DEFAULT_NAMES}/]`,
  // The same name anywhere inside a wrapped default: `as`, `satisfies`, `!`, a
  // template, a call, a sequence, `??`, a ternary, or anything TypeScript adds
  // next. It also covers `f(tz = operational.APP_TIME_ZONE)` and
  // `f(tz = ns?.APP_TIME_ZONE)` without a member-specific arm, because the
  // property of a non-computed member expression is itself an `Identifier` node
  // — which is why no `[property.name=...]` arm is listed here. Adding one back
  // would report those twice.
  `AssignmentPattern > .right Identifier[name=/${CLUB_AUTHORITY_DEFAULT_NAMES}/]`,
  // `f(tz = operational["APP_TIME_ZONE"])`, whose property is a Literal rather
  // than an Identifier, so the pair above cannot see it. Computed access is the
  // documented escape from every syntactic rule in this file and is closed on
  // the way in rather than recorded as a known limitation.
  `AssignmentPattern > MemberExpression.right[property.value=/${CLUB_AUTHORITY_DEFAULT_NAMES}/]`,
  `AssignmentPattern > .right MemberExpression[property.value=/${CLUB_AUTHORITY_DEFAULT_NAMES}/]`,
  // `f(tz = process.env.TZ)` and `f(tz = process.env["TZ"])`, plus every wrapped
  // spelling of each. Anchored on `.env.<VAR>` rather than on the receiver being
  // literally `process`, so `globalThis.process.env.TZ` is closed too.
  `AssignmentPattern > MemberExpression.right[object.property.name="env"][property.name=/${CLUB_AUTHORITY_DEFAULT_ENV}/]`,
  `AssignmentPattern > .right MemberExpression[object.property.name="env"][property.name=/${CLUB_AUTHORITY_DEFAULT_ENV}/]`,
  `AssignmentPattern > MemberExpression.right[object.property.name="env"][property.value=/${CLUB_AUTHORITY_DEFAULT_ENV}/]`,
  `AssignmentPattern > .right MemberExpression[object.property.name="env"][property.value=/${CLUB_AUTHORITY_DEFAULT_ENV}/]`,
].map((selector) => ({ selector, message: AUTHORITY_DEFAULT_MESSAGE }));

const AUTHORITY_DEFAULT_RESTRICTIONS = [...NO_CLUB_AUTHORITY_DEFAULT];

/**
 * The `INV-SSOT-003` arm family as bare selector strings, for
 * `ssot-authority-default-guard.test.ts` — the same mirror `DATE_GUARD_ARMS` and
 * `CLUB_TIME_GUARD_ARMS` provide for their own families.
 *
 * Read from HERE rather than from a copy in the suite: a copy passes happily
 * while the config that ships has dropped the arm.
 */
export const SSOT_GUARD_ARMS = {
  authorityDefault: AUTHORITY_DEFAULT_RESTRICTIONS.map((entry) => entry.selector),
};

// ---------------------------------------------------------------------------
// Composition: every restriction that must survive in EVERY `src/**` block,
// whatever else that block is there to lift.
// ---------------------------------------------------------------------------
//
// A comment saying "re-state these" was the whole mechanism until now, and it
// only holds while everyone reads it — flat config REPLACES a rule's option list
// rather than merging it, so a block written to lift one rule takes every other
// rule down with it and lint still passes.
//
// A MERGE can do the same thing from the other direction, and more quietly. When
// two branches each add a block here, git can align the conflict so one side's
// whole restriction group sits inside the hunk and the other side's is a closing
// paren; resolving THAT the obvious way deletes a guard outright and the file
// still parses. So the rule LISTS live here as named arrays, separately from the
// blocks that apply them, and every block's rule value is a function CALL —
// never an array literal. Merging two named arrays is a decision somebody can
// see; merging two block literals is how a guard disappears.
//
// THAT IS NOT A HYPOTHETICAL. #2684 and #2685 were built in parallel, each
// adding its own guard and its own blocks, and a three-way merge of the two
// aligned #2685's whole money group inside a hunk whose #2684 side was a single
// `),`. Resolving it the obvious way deleted the money guard's broad arm and its
// helper exemption, and the file still parsed. The fold below is the answer:
// ONE mandatory array, THREE named groups inside it, and no block that spells
// out a list of its own.
//
// ADDING A GUARD: put its restrictions in a named array beside the others below
// and add that array here. That is the only edit needed — every block picks it
// up, INCLUDING the `scripts/` and `prisma/` blocks, and BOTH
// `date-only-encoding-guard.test.ts` and `money-cents-guard.test.ts` read this
// same array, so the integrity checks extend themselves rather than each needing
// its own copy of the list.
//
// "INCLUDING the `scripts/` and `prisma/` blocks" is a promise this file used to
// break. `operatorScriptRestrictedSyntax()` hand-wrote `[...RAW_SQL,
// ...MONEY_CENTS]` four lines under a comment saying adding an array here was
// the only edit needed — so a guard added here would silently not have reached
// either directory, and NEITHER suite could have noticed, because both skipped
// any block whose globs do not start with `src/`. Both now go through the shared
// path, and the roster in `eslint-guard-coverage.ts` carries a `scripts/` and a
// `prisma/` path so the audit sees them.
const ALWAYS_RESTRICTED_IN_SRC = [
  ...RAW_SQL_RESTRICTIONS,
  ...DATE_ONLY_ENCODING_RESTRICTIONS,
  ...ZONED_FORMATTER_RESTRICTIONS,
  ...HOST_CLOCK_RESTRICTIONS,
  ...ENVIRONMENT_ZONE_RESTRICTIONS,
  ...DATE_FNS_RESTRICTIONS,
  ...MONEY_CENTS_RESTRICTIONS,
  ...AUTHORITY_DEFAULT_RESTRICTIONS,
];

/**
 * Blocks allowed to omit part of the mandatory set, each with the group it omits
 * and why. Exported so the integrity test reads the SAME record instead of
 * keeping its own copy, which would drift out of step with this file.
 *
 * `files` must match a block's list EXACTLY, so widening a block's globs does
 * not quietly widen its exemption too.
 */
export const SRC_RESTRICTION_EXEMPTIONS = [
  {
    files: ["src/lib/date-only.ts"],
    omits: [...DATE_ONLY_ENCODING_RESTRICTIONS],
    reason:
      "The canonical home for the date-only encoding (#2684): the rule exists to make every OTHER file call these helpers instead of hand-writing the truncation, and the helpers have to write it somewhere. It carried the ENVIRONMENT-ZONE group too until #3123, because six of its helpers defaulted their `timeZone` to `APP_TIME_ZONE`; those defaults and the import are gone, every caller passes a zone, and the exemption went with them. An exemption is deleted when its cause is, not when somebody next happens to read the block.",
  },
  {
    files: DATE_FNS_ADAPTER_FILES,
    omits: DATE_FNS_RESTRICTIONS,
    reason:
      "The seven files still importing `date-fns`, measured by CT-6 (#2991). Two are relative-duration hints that are genuinely zone-free; the rest are the admin report bucket/date-series residual #2870 already carries. Each entry on `DATE_FNS_ADAPTERS` above names what it uses and what is blocking it, and the list is a ratchet.",
  },
  {
    files: ENVIRONMENT_ZONE_ADAPTER_FILES,
    omits: ENVIRONMENT_ZONE_RESTRICTIONS,
    reason:
      "The two structural readers of the environment's zone, plus the callers CT-6 (#2991) could not migrate without threading a club zone through a surface belonging to another issue. Entries leave this list BOTH ways and #3123 did each: it DELETED `src/lib/nzst-date.ts` once its last production caller had moved, and it MIGRATED `src/lib/member-guest-consent-labels.ts` and `src/lib/member-guest-delegate-page.ts` by threading the club's persisted zone through them. #3126 then took `src/lib/member-merge-field-kinds.ts` off by deleting the `= APP_TIME_ZONE` DEFAULT the exemption had been covering (`INV-SSOT-003`) — an exemption written for a READ should never have excused a default, and `AUTHORITY_DEFAULT_RESTRICTIONS` is on the mandatory set precisely so no entry here can excuse one again. Migration is the intended way off this list; deletion is the terminus for a module with nothing left to do. No count is stated here on purpose — the length is asserted in exactly one place, `club-time-boundary-guard.test.ts`, and a number restated in prose is a number that drifts. Every entry carries its own reason on `ENVIRONMENT_ZONE_ADAPTERS` above, and the list is a ratchet the census test refuses to let grow.",
  },
  {
    files: ["prisma/**/*.{ts,tsx}"],
    omits: DATE_ONLY_ENCODING_RESTRICTIONS,
    reason:
      "The seed and fixture files synthesise date STRINGS for a throwaway database rather than reading a domain column (#2684), and `prisma/e2e-fixtures.ts` is contractually a pure constants module — importing `@/lib/date-only` would pull `@/config/operational` into a file whose whole point is that it imports nothing. `scripts/` gets no such exemption: it carries the full set.",
  },
  {
    files: MONEY_DOMAIN_MODULES,
    omits: MONEY_CENTS_RESTRICTIONS,
    reason:
      "STRICTER, not weaker (#2685): inside the money-domain modules a bare `x * 100` is a cents conversion by construction, so MONEY_MODULE_RESTRICTIONS below replaces the narrow shape-based arms with one that subsumes them. Listing both reported the same node two and three times at the identical line:column.",
  },
  {
    files: MONEY_HELPER_MODULES,
    omits: MONEY_CENTS_RESTRICTIONS,
    reason:
      "The two reviewed money boundaries (#2685). They own the conversion every other file is sent here to use, so they are the one place allowed to write it; each carries its own written reason on MONEY_GUARD_EXEMPTIONS above.",
  },
];

/** The mandatory set, for the integrity test to measure blocks against. */
export const MANDATORY_SRC_RESTRICTIONS = ALWAYS_RESTRICTED_IN_SRC;

/**
 * `no-restricted-syntax` for a `src/**` block: the mandatory restrictions, plus
 * whatever that block adds. Always use this rather than writing the array out.
 */
function srcRestrictedSyntax(...additional) {
  return ["error", ...ALWAYS_RESTRICTED_IN_SRC, ...additional];
}

/**
 * The same, minus ONE named group — for a block that legitimately cannot obey a
 * single guard (the helper module that implements it, say) but must keep every
 * other. Dropping a group BY NAME keeps whatever arrives later, which writing
 * the remaining list out by hand would not.
 *
 * The omission must also appear in `SRC_RESTRICTION_EXEMPTIONS`, or the
 * integrity test rejects it.
 */
function srcRestrictedSyntaxWithout(omitted, ...additional) {
  const dropped = new Set(omitted.map((restriction) => restriction.selector));
  return [
    "error",
    ...ALWAYS_RESTRICTED_IN_SRC.filter((r) => !dropped.has(r.selector)),
    ...additional,
  ];
}

/**
 * `prisma/` takes everything except the date-only ENCODING restrictions, which
 * two seed files there genuinely cannot obey; the block below gives the reason,
 * and it is recorded on `SRC_RESTRICTION_EXEMPTIONS` like every other omission.
 *
 * `scripts/` needs no function of its own: it takes the whole mandatory set
 * through `srcRestrictedSyntax()`, exactly as `src/**` does.
 */
function operatorSeedRestrictedSyntax() {
  return srcRestrictedSyntaxWithout(DATE_ONLY_ENCODING_RESTRICTIONS);
}

const eslintConfig = defineConfig([
  ...fixupConfigRules(nextVitals),
  ...fixupConfigRules(nextTs),
  {
    rules: {
      // The current admin/lodge UI relies on effect-driven fetch/reset flows.
      // Enabling these rules would require a broad React refactor rather than
      // a lint-only cleanup pass.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
    },
  },
  {
    /*
      #2690, owner decision 15 Aug 2026 — ONE of the two rules above is switched
      back on, for ONE folder.

      `react-hooks/static-components` is measured at zero errors across
      `src/components/edit-booking/**`, both before and after the edit-panel
      split, so turning it on changes nothing today and costs nothing. Its value
      is forward-looking: it stops a component being defined inside another
      component from being reintroduced into the folder the split just cleaned.
      That mistake gives the inner component a new identity on every render, so
      React discards and rebuilds that part of the tree instead of updating it —
      which reaches a user as typed text being wiped, focus jumping out of a
      field, or a panel flickering.

      `react-hooks/set-state-in-effect` is deliberately NOT enabled here. Two
      sites in this folder still trip it: the per-guest-dates auto-disable in
      `hooks/use-guest-date-modes.ts` and the hosting-override retirement in
      `hooks/use-hosting-coverage-override.ts`. Both are reset flows, and
      rewriting either to derive during render changes WHEN the reset fires on
      the admin booking screen. That is a real behaviour change, and #2690's
      whole claim is that it changes none, so it is not being smuggled in behind
      a lint switch.

      THE BLIND SPOT, and it matters more than the count. Measured on this
      refactor: `set-state-in-effect` reported THREE errors in the monolithic
      panel and TWO after the split. Nothing was fixed. The one that disappeared
      is the debounced quote effect's `setQuote(null)`, and it disappeared only
      because `setQuote` became a hook PARAMETER — the rule can no longer prove
      a value it received as an argument is a state setter, so it stops looking.
      The code is identical; the checker went blind to it.

      So "two remaining" flatters this folder, and the same discount applies to
      any future effect extracted into a hook that takes its setters as
      arguments — which is exactly the shape this refactor introduced. Do not
      read a falling number here as the folder getting cleaner.

      Scope is deliberately this folder and nothing else. The repository-wide
      `off` above is untouched; widening either rule is a separate decision with
      its own measurement.
    */
    /*
      Every extension the ratchet treats as production, not just .ts/.tsx. Next
      serves .js/.jsx by default and tsconfig sets allowJs, so a component
      written as .jsx in this folder would otherwise be scoped out of the very
      rule this block exists to apply — and, as file-size-budget.ts records, a
      .js file under src is policed by nothing at all.
    */
    files: ["src/components/edit-booking/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    rules: {
      "react-hooks/static-components": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // The Xero subsystem's internal modules must depend on the focused domain
    // module that owns each symbol, not on the `@/lib/xero` compatibility
    // facade (which exists only for external callers). Importing the facade
    // from within `src/lib/xero-*` hides the real dependency graph and invites
    // import cycles (#1208). The exact-path match here does NOT fire on the
    // `@/lib/xero-*` domain modules — only on the bare facade path. The glob
    // also covers subsystem split directories such as `src/lib/xero-inbound/`
    // (#1270) so the guard follows the code into its new home; `../xero` is the
    // relative facade path seen from those nested modules.
    files: ["src/lib/xero-*.ts", "src/lib/xero-*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/xero",
              message:
                "xero-* modules must import the source domain module directly, not the @/lib/xero compatibility facade (#1208).",
            },
            {
              name: "./xero",
              message:
                "xero-* modules must import the source domain module directly, not the @/lib/xero compatibility facade (#1208).",
            },
            {
              name: "../xero",
              message:
                "xero-* modules must import the source domain module directly, not the @/lib/xero compatibility facade (#1208).",
            },
          ],
        },
      ],
    },
  },
  {
    // #2264 — every rendered date and time must go through the club's ONE
    // rendering seam, `@/lib/club-time` (CT-2, #2990). The six NZ-pinned helpers
    // in `src/lib/nzst-date.ts` (`formatNZDate`, `formatNZDateTime`,
    // `formatNZLongDate`, `formatNZTime`, `formatNZMonthYear`,
    // `formatNZWeekdayDate`) were that seam until CT-2 made them delegate to the
    // kernel and #3123 deleted the file. A bare `toLocaleDateString()` /
    // `toLocaleTimeString()` / `toLocaleString()` renders in the VIEWER's time
    // zone and locale, so an admin abroad saw a different lodge night than the
    // one stored, and the lobby clock showed the wrong time on a TV whose
    // browser was not set to New Zealand (#2256, #2264).
    //
    // ALL THREE `toLocale*` date entry points are restricted. `toLocaleString`
    // was originally left out because `Number.prototype.toLocaleString` is
    // thousands-separator formatting and has nothing to do with dates — but
    // roughly a quarter of the sites this issue fixed were date-context
    // `toLocaleString` calls, so leaving it unguarded left the biggest single
    // hole in a rule `docs/DOMAIN_INVARIANTS.md` claims closes the class. It is
    // restricted here, and the three files that genuinely format NUMBERS get a
    // narrow block of their own below.
    //
    // KNOWN LIMITATION (accepted): the selector is syntactic, so computed
    // access (`d["toLocaleDateString"]()`) and a detached method alias
    // (`const f = d.toLocaleDateString; f()`) both slip past it. Neither
    // appears in the tree and neither is a shape anyone writes by accident;
    // the rule is a guard against the ordinary mistake, not a sandbox.
    //
    // A site whose format is legitimately none of the six helper shapes
    // (weekday-bearing, month-year-short, seconds-bearing, or an `en-CA` ISO
    // extractor) is expressed as a module-level
    // `new Intl.DateTimeFormat(APP_LOCALE, { timeZone: APP_TIME_ZONE, … })`
    // constant, which is both zone-correct and rule-clean. THAT is the escape
    // hatch — not an `eslint-disable` comment. There are none in the tree, and
    // a new one should be read as a site that was never classified.
    //
    // Documented exclusions (each has its own block below):
    //   * `src/lib/date-only.ts` — the helper module itself, the sanctioned home
    //     for the date-only encoding. `src/lib/nzst-date.ts` sat beside it until
    //     CT-2 (#2990) took its exemption away and #3123 deleted the file.
    //   * `src/lib/email-templates/chores.ts` — `formatChoreRosterDate`
    //     (#2256): the chore-roster long-weekday subject line and body must stay
    //     byte-identical, and the helper is shared with `src/lib/email/chores.ts`.
    //     Flat config cannot scope a rule to one function, so the exemption is
    //     still file-wide — but the file is now the 88-line chore-template
    //     module rather than the 5,000-line template monolith (#2689), which is
    //     as narrow as flat config allows. New date rendering in it must still
    //     use the helpers.
    //   * the three Number-formatting files — a narrowed block, NOT an `off`:
    //     they keep both date restrictions and drop only `toLocaleString`.
    //   * `src/lib/xero-invoice-helpers.ts` — ISO payload dates for the Xero
    //     API. Listed for the record only: it builds them with `toISOString()`,
    //     so it never actually trips this rule and needs no block.
    //   * tests — expectation builders deliberately mirror a component's
    //     current (non-standard) format, which is how they catch a drift.
    //   * `e2e/**` is outside this block's `files` glob already (`src/**`
    //     only). `e2e/helpers/booking.ts`, `e2e/helpers/stay-dates.ts` and
    //     `e2e/admin-retroactive-booking.spec.ts` build expected label strings
    //     on purpose; if this rule is ever widened to the repository root, add
    //     an `off` block for `e2e/**`.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": srcRestrictedSyntax(...DATE_RENDERING_RESTRICTIONS),
    },
  },
  {
    // CT-6 (#2991) — the files still importing `date-fns`. Reasons are on
    // `DATE_FNS_ADAPTERS` above. The rendering arms are re-stated for the same
    // reason as the block below: flat config replaces, it does not merge.
    files: DATE_FNS_ADAPTER_FILES,
    rules: {
      "no-restricted-syntax": srcRestrictedSyntaxWithout(
        DATE_FNS_RESTRICTIONS,
        ...DATE_RENDERING_RESTRICTIONS,
      ),
    },
  },
  {
    // CT-6 (#2991) — the files allowed to name the ENVIRONMENT's zone. The
    // reason for each is on `ENVIRONMENT_ZONE_ADAPTERS` above, where the census
    // test can read it; only the group is dropped here.
    //
    // The DATE_RENDERING arms are re-stated rather than inherited, because flat
    // config REPLACES a rule's options: a block that merely dropped one group
    // would take the three rendering arms down with it, silently, for every file
    // named here. That is not hypothetical — it is what CT-2 (#2990) deliberately
    // undid for `nzst-date.ts` by taking its rendering exemption away, on the
    // file that WAS the club's rendering seam (#3123 has since deleted it). This
    // is the failure the fold above exists to prevent, arriving through a new
    // block rather than through a merge.
    files: ENVIRONMENT_ZONE_ADAPTER_FILES,
    rules: {
      "no-restricted-syntax": srcRestrictedSyntaxWithout(
        ENVIRONMENT_ZONE_RESTRICTIONS,
        ...DATE_RENDERING_RESTRICTIONS,
      ),
    },
  },
  {
    // The raw-SQL guard (#2289) is NOT an `src/`-only rule, even though the date
    // rules above are. Operator CLIs and seed/migration helpers are where
    // hand-written SQL is most likely — Prisma cannot express a bulk correlated
    // update, and these files run against production data with an operator
    // watching a row count. `scripts/` alone holds the money-adjacent
    // `backfill-orphaned-applied-credits.ts`,
    // `backfill-cancel-flattened-payments.ts`,
    // `backfill-finance-monthly-facts.ts` and `xero-booking-repair.ts`. Neither
    // directory contains any raw SQL today, so this costs nothing now and is
    // purely about what may be written next — and it makes the unqualified
    // promise in CONTRIBUTING.md and docs/DOMAIN_INVARIANTS.md true rather than
    // aspirational.
    //
    // `e2e/**` is deliberately NOT here: it is entirely Playwright tests, which
    // are exempt for the same reason `src/**/__tests__/**` is (see the last
    // block) — a test's raw statement runs against a throwaway database and its
    // result is asserted on the spot.
    //
    // `scripts/` takes the WHOLE mandatory set, date-only encoding included.
    //
    // This used to be one block over both directories that omitted the #2684
    // encoding restrictions, on the ground that "the guard follows the DOMAIN,
    // which lives in `src/`" — four lines above extending the MONEY guard here
    // because "`scripts/` holds the money-adjacent backfills". Both arguments
    // apply equally to both guards, so the asymmetry was reasoning, not a
    // reason. `scripts/` contains ZERO truncations today (the only two outside
    // `src/` are `prisma/demo-seed.ts:81` and `prisma/e2e-fixtures.ts:46`), so
    // extending the date restrictions here costs nothing and closes it. The real
    // exemption belongs to `prisma/`, and it has its own block below.
    files: ["scripts/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": srcRestrictedSyntax(),
    },
  },
  {
    // `prisma/` — same as `scripts/`, minus the #2684 encoding restrictions, and
    // the two files that need that say why. `prisma/demo-seed.ts` and
    // `prisma/e2e-fixtures.ts` synthesise date STRINGS for a throwaway database
    // rather than reading a domain column, and `e2e-fixtures.ts` declares itself
    // "a pure constants module: no Playwright, no Prisma, no `server-only`
    // imports" — importing `@/lib/date-only` would pull `@/config/operational`
    // into a module whose whole contract is that it imports nothing.
    //
    // Dropped BY NAME, and recorded on `SRC_RESTRICTION_EXEMPTIONS`, so every
    // other guard — raw SQL, money, the zoned-formatter rule, anything added
    // later — still reaches every seed and migration helper.
    files: ["prisma/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": operatorSeedRestrictedSyntax(),
    },
  },
  {
    // The one documented format exclusion left.
    // Flat config replaces a rule's whole option list rather than merging it, so
    // this block re-states the mandatory restrictions (#2289, #2684) instead of
    // switching `no-restricted-syntax` off outright: the file contains no raw
    // SQL and no hand-written date truncation, and the exemption it needs is
    // from the toLocale* DATE-RENDERING rules only. Same reasoning in the
    // Number-formatting block below.
    //
    // `src/lib/nzst-date.ts` USED TO BE LISTED HERE, was taken off in CT-2
    // (#2990), and no longer exists at all: #3123 deleted it. It held the six
    // frozen `Intl.DateTimeFormat` constants the club's rendering seam was built
    // from, then delegated every one of them to `@/lib/club-time` and so needed
    // no exemption. Recorded because the sequence is the rule: an adapter loses
    // its exemption when it stops formatting, and is deleted when its last
    // caller moves — it is never left exempt "for now". The census in
    // `src/lib/club-time/__tests__/club-time-kernel-census.test.ts` is the other
    // half: it refuses an `Intl.DateTimeFormat` in the remaining adapter, and
    // refuses the deleted file coming back.
    files: ["src/lib/email-templates/chores.ts"],
    rules: {
      "no-restricted-syntax": srcRestrictedSyntax(),
    },
  },
  {
    // `src/lib/date-only.ts` is the ONE file exempt from the #2684 encoding
    // restrictions, because it is the sanctioned home for the truncation: the
    // rule exists to make every other file call `formatDateOnly` instead of
    // writing `toISOString().slice(0, 10)`, and that helper has to write it
    // somewhere. It still carries the raw-SQL and money restrictions, which have
    // nothing to do with that.
    //
    // IT USED TO DROP THE ENVIRONMENT-ZONE GROUP TOO, and #3123 took that back.
    // Six helpers here defaulted their `timeZone` parameter to `APP_TIME_ZONE`;
    // once every caller passed a zone the defaults and the import went, and the
    // exemption had nothing left to excuse. A lifted guard outlives its cause in
    // SILENCE — no assertion fails on the day the last violation leaves the file
    // — which is why `club-time-boundary-guard.test.ts` now re-reads every file
    // this config excuses from that group, not only the ones named on
    // `ENVIRONMENT_ZONE_ADAPTERS`, and fails on one whose code no longer names
    // the environment zone.
    //
    // This is the only entry `date-only-encoding-guard.test.ts` accepts on its
    // exemption list. A second file added here is a site that was never
    // classified, not a file that needs an exemption.
    files: ["src/lib/date-only.ts"],
    rules: {
      // Drops ONE named group. Every other guard — the raw-SQL restrictions, the
      // money restrictions and the environment-zone arms today, anything added
      // later — stays on this file automatically.
      "no-restricted-syntax": srcRestrictedSyntaxWithout(
        DATE_ONLY_ENCODING_RESTRICTIONS,
      ),
    },
  },
  {
    // Number formatting, not dates: these three call
    // `Number.prototype.toLocaleString` for thousands separators, so only that
    // one restriction is lifted — both date restrictions still apply here.
    files: [
      // Character counter: "12,345 / 50,000 characters" on the raw-CSS box.
      "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
      // Validation message quoting the notice body's character limit.
      "src/components/admin/notice-editor.tsx",
      // Redemption/export row counts in the promo-code panel.
      "src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx",
    ],
    rules: {
      "no-restricted-syntax": srcRestrictedSyntax(
        NO_BARE_TO_LOCALE_DATE_STRING,
        NO_BARE_TO_LOCALE_TIME_STRING,
      ),
    },
  },
  {
    // #2685 — inside the money-domain modules a bare `x * 100` is a cents
    // conversion by construction, so the broad selector replaces the narrower
    // shape-based arms FOR THAT SHAPE rather than joining them: it matches the
    // same node they do, and listing both made the commonest real mistake report
    // two and three times at the same line and column; a 25-site regression
    // printed sixty identical messages and read far worse than it was (#2685
    // review). These files compute no percentages: that is what makes the broad
    // selector safe here and unsafe anywhere else.
    //
    // IT IS NOT, HOWEVER, STRICTLY STRONGER THAN THE NARROW ARMS, and this
    // config used to claim it was. The broad arm excludes a division inside the
    // multiplication so that a genuine percentage stays writable, and for a
    // while that exclusion was the only money rule these files had — so a typed
    // amount that was DIVIDED and then scaled, `(parseFloat(gross) / 1.15) * 100`
    // or `(parseFloat(raw) / guests) * 100`, was caught in an ordinary
    // `src/lib` file and caught nowhere at all in a Xero module, a payment
    // module or an API route. `MONEY_MODULE_RESTRICTIONS` therefore states the
    // ratio-of-a-parse arm explicitly; see the comment above it.
    //
    // It drops the narrow money group BY NAME and adds the broad one, so every
    // OTHER guard rides along untouched. That is not a nicety here: this glob
    // list is every Xero, finance, membership-cancellation, payment, credit,
    // refund, promo, fee, invoice, subscription, pricing and Stripe module plus
    // the whole of `src/app/api/**` — which is to say most of the surface
    // #2684's encoding guard exists for. A block that spelled its own list out
    // would have lifted that guard from all of it with lint still green.
    files: MONEY_DOMAIN_MODULES,
    rules: {
      "no-restricted-syntax": srcRestrictedSyntaxWithout(
        MONEY_CENTS_RESTRICTIONS,
        ...DATE_RENDERING_RESTRICTIONS,
        ...MONEY_MODULE_RESTRICTIONS,
      ),
    },
  },
  {
    // #2685 — the exempt paths. The money restrictions are lifted here and ONLY
    // here, each with its written reason on `MONEY_GUARD_EXEMPTIONS` above; the
    // date and raw-SQL restrictions still apply, which is why this block drops
    // one named group rather than switching the rule off.
    files: MONEY_HELPER_MODULES,
    rules: {
      "no-restricted-syntax": srcRestrictedSyntaxWithout(
        MONEY_CENTS_RESTRICTIONS,
        ...DATE_RENDERING_RESTRICTIONS,
      ),
    },
  },
  {
    // Test expectation builders mirror the component format under test.
    //
    // The raw-SQL restrictions (#2289) are off here too, deliberately. A test's
    // raw statement runs against a throwaway database and its result is
    // asserted on the spot, so a wrong shape fails the test rather than
    // silently mispricing a booking — `concurrency-lock-races.realdb.test.ts`
    // reads counts that way on purpose. What must never regress is PRODUCTION
    // code, and `raw-sql-shape-guard.test.ts` pins that inventory file by file.
    files: ["src/**/__tests__/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // #2686: Semgrep rule fixtures. Deliberately-broken sample code that exists
    // to be reported by `.semgrep/rules/**`; linting it would report the same
    // faults a second time, in a tool that cannot express why they are there.
    ".semgrep/**",
    // #3078: local scratch space, not source. `.gitignore` already declares
    // `/.artifacts/` non-source, so nothing here is ever committed or built,
    // and `docs/agents/SCOPED_CONTEXT.md` describes it as ignored, local,
    // bounded context. Linting it made an interrupted agent's half-written
    // mutation harness the only "error" in an unrelated lane's `npm run lint`
    // — a wrong signal at the exact moment the next agent is reconstructing
    // state. The ignore is the whole directory rather than today's harness
    // extension, so the next harness cannot bring the problem back.
    ".artifacts/**",
  ]),
]);

export default eslintConfig;
