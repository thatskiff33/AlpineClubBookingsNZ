import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The club's day reaches a lock-bound writer as a VALUE, never as a read taken
 * under its locks (#3123; `INV-LOCK-004`).
 *
 * ## What this protects, and why a runtime test cannot
 *
 * `INV-LOCK-004`: *"Two more cannot take one — the subscription-lockout mode
 * and the club timezone — and are resolved before the transaction opens and
 * passed in as a value instead."* Eight sites in the bed-allocation lifecycle,
 * the hosting-coverage fan-out, the lodge deactivation guard and the shared
 * guest-removal path used to answer "what day is it" from the container's
 * environment zone inside a transaction holding `pg_advisory_xact_lock(1)` and
 * the per-lodge capacity key. Each now takes a required `today`.
 *
 * A ninth joined them: the bed board's date-range parse, whose default window
 * starts at the club's day and whose product is consumed inside exactly those
 * locked transactions by `bed-allocation-approval.ts` and
 * `bed-allocation-auto-allocate.ts`. The parse itself is synchronous and never
 * ran inside a transaction — but the lazy fix for it was to make it `async` and
 * read the zone in place, which would have put a `ClubTimeSettings` query on the
 * approve path a few lines before the global key is taken, and left the next
 * caller free to invoke it from inside the span. It is covered here rather than
 * only by the census so that shape stays foreclosed.
 *
 * That fix has TWO failure modes and only one of them changes a date. Reading
 * the persisted zone in the wrong PLACE still produces the right day — and a
 * `clubTimeSettings.findUnique` on a second pooled connection, held for the
 * length of that query behind whatever the transaction locked. Member merge
 * makes the cost concrete: it runs on a 120s budget holding every affected
 * lodge key, against counterparts on Prisma's default 5s budget that are
 * REJECTED with `P2028` rather than queued.
 *
 * No runtime suite can cover the population, because most of these sixteen
 * caller files need a whole booking, member and Xero fixture to drive one line.
 * A source scan covers all of them at once, which is exactly the argument
 * `payment-link-expiry-club-zone.test.ts` makes for the four payment-link
 * writers — this is that guard, for a much larger set, and A1's
 * needs-decision item resolved in favour of having one.
 *
 * ## The money chains joined this file rather than getting their own (#3123)
 *
 * `daysUntilDate` (the cancellation refund tier) and `validatePromoCodeRules`
 * (a promotion's validity window) are both SYNCHRONOUS, PURE and
 * TRANSACTION-BOUND, which is the same shape as everything above and the same
 * reason the fix is a required parameter rather than an `await`. Between them
 * they are reached from ten and ten call sites across a dozen money modules,
 * four of the promo ones from inside a transaction that additionally holds a
 * `FOR UPDATE` lock on the promo row. Splitting them into a second, identical
 * source contract would have been two scanners to keep working instead of one.
 *
 * ## Four properties, because each of them is separately losable
 *
 * 1. **No club-zone reader inside a `$transaction` callback.** The lock rule.
 * 2. **Every caller file still reads the club's zone somewhere.** Without this,
 *    deleting the read entirely — or replacing the threaded value with
 *    `new Date()` — passes rule 1 perfectly.
 * 3. **No legacy environment-zone helper anywhere in the set.** `INV-CONFIG-002`:
 *    the day must come from the persisted setting, and `getTodayDateOnly()` /
 *    `APP_TIME_ZONE` are how it came from the container instead. ESLint's
 *    `NO_ENVIRONMENT_ZONE_IMPORT` arm covers the import; this covers the call.
 * 4. **Both of the populations above are DERIVED from the tree, not
 *    remembered.** Which spellings open a transaction, and which files call the
 *    caller-transaction wrapper, were both hand-maintained lists — so a new
 *    member of either was simply not covered and nothing said so. Twice now, a
 *    real `INV-LOCK-004` violation reached a green suite through exactly that
 *    gap. A scan finds them and the hand-written lists have to agree with it.
 *
 * The scanner is a bracket matcher, not a parser, for the reason
 * `payment-link-expiry-club-zone.test.ts` gives: a hand-rolled TypeScript
 * parser in a guard is a larger liability than the property it protects. The
 * vacuity case at the end is what catches a scanner that has stopped matching.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Every file that resolves the club's day for one of the eight lock-bound
 * entry points. Grouped by the reader each one is entitled to, because that
 * choice is itself a measured decision (`docs/CLUB_TIME_KERNEL.md` -> "Where
 * the zone comes from") and a file in the wrong group breaks at import rather
 * than in a date.
 */
const RESOLVERS = {
  /**
   * Clean on all three reach axes (no CLI root, no `instrumentation.node.ts`
   * edge, no client bundle), or already carrying `import "server-only"` so the
   * server binding adds no hazard that is not already there.
   */
  serverBinding: [
    "src/app/api/admin/lodges/[id]/route.ts",
    "src/app/api/admin/deletion-requests/[id]/route.ts",
    "src/app/api/admin/members/bulk-update/route.ts",
    "src/app/api/bookings/[id]/guests/[guestId]/route.ts",
    // The three bed-board doors. Each resolves ONE club day before it calls the
    // date-range parse, whose window the locked writer then acts on (#3123).
    "src/app/api/admin/bed-allocation/route.ts",
    "src/app/api/admin/bed-allocation/approve/route.ts",
    "src/app/api/admin/bed-allocation/auto-allocate/route.ts",
    "src/lib/bed-allocation-beds.ts",
    "src/lib/bed-allocation-rooms.ts",
    "src/lib/member-merge.ts",
    "src/lib/member-partner-link.ts",
    "src/lib/manual-subscription-payment.ts",
    "src/lib/member-lifecycle-actions.ts",
    "src/lib/membership-cancellation-admin.ts",
    // The MONEY chains (#3123). Each of these resolves ONE club day before it
    // opens its transaction and threads it into every decision inside: the
    // cancellation refund tier (`daysUntilDate`), the late-notice change fee,
    // the reduction refund's settlement tier, and the promotion's validity
    // window. Two of the five open no transaction at all and are covered by the
    // "still reads" and "right reader" rules only.
    "src/app/api/bookings/[id]/cancel-preview/route.ts",
    "src/app/api/bookings/[id]/modify-quote/route.ts",
    "src/app/api/bookings/[id]/guests/route.ts",
    "src/app/api/promo-codes/validate/route.ts",
    "src/lib/booking-date-modification-service.ts",
    // The PERSON-NIGHT guard's doors (#3123 review). `findBookingMemberNight-
    // Conflicts` used to read the club's zone for itself, from inside nine
    // booking-write transactions holding `pg_advisory_xact_lock(1)`, the
    // per-lodge capacity key and a per-member night lock per linked guest. Each
    // of these files now resolves the day before its transaction opens and
    // threads it in; the two `modify` doors additionally supply it to the
    // transaction-AWARE services, which cannot resolve one for themselves.
    "src/app/api/bookings/route.ts",
    "src/app/api/bookings/quote/route.ts",
    "src/app/api/bookings/[id]/modify/route.ts",
    "src/app/api/admin/booking-requests/[id]/link-conflicts/route.ts",
    "src/app/api/admin/booking-exception-requests/[id]/route.ts",
    // The AI-diagnostics booking pack. Its person-night scan and its edit-policy
    // gate both run inside `withBoundedReadOnlyTransaction`, so the day is
    // resolved by the entry point above it and threaded through.
    "src/lib/diagnostics/tools/packs/booking-evidence.ts",
  ],
  /**
   * Reachable from a CLI entry point or from `src/instrumentation.node.ts`,
   * where `@/lib/club-time/server`'s `import "server-only"` is a bare throw AT
   * IMPORT — before the job prints anything. These take the runtime reader.
   * `admin-member-detail-service.ts` is here because the file already uses it
   * and one reader per module beats two.
   */
  runtimeReader: [
    "src/lib/admin-member-detail-service.ts",
    "src/lib/member-guest-consent-service.ts",
    "src/lib/seasonal-membership-assignments.ts",
    "src/lib/xero-membership-sync.ts",
    // The MONEY chains again, on the reader their reach entitles them to
    // (#3123). `booking-cancel.ts` and `booking-create.ts` are reachable from a
    // CLI root or from `instrumentation.node.ts`; `group-cancel.ts` through
    // `payment-recovery.ts` and `waitlist.ts` through `cron-waitlist.ts`.
    // `promo.ts` is BOTH — it resolves the zone once for the member's assigned
    // promotion list and takes the day as a value on the validator path four
    // locked callers reach.
    "src/lib/booking-cancel.ts",
    "src/lib/booking-create.ts",
    "src/lib/group-cancel.ts",
    "src/lib/promo.ts",
    "src/lib/waitlist.ts",
    // The MEMBER-GUEST consent deadline (#3123, group F). This module opens no
    // transaction of its own, and that is the point: `loadMemberGuestAddPolicy`
    // is the read every one of the eight add paths already had to perform BEFORE
    // opening theirs — an ordering rule `member-guest-add-call-sites.test.ts`
    // enforces — so hanging the club's zone off the policy value puts the
    // `clubTimeSettings` query outside the global booking lock and every
    // per-lodge capacity key by construction. It takes the runtime reader
    // because `booking-request.ts` and `booking-request-quotes.ts` import it and
    // `src/instrumentation.node.ts` reaches both through the cron chain.
    "src/lib/member-guest-add-policy.ts",
    // The PERSON-NIGHT guard's doors that a cron or a CLI also reaches (#3123
    // review). The booking-request family is walked from
    // `src/instrumentation.node.ts` through the cron chain;
    // `waitlist-cross-lodge.ts` through `cron-waitlist.ts`; `group-booking.ts`
    // sits on the shared `src/lib` graph a CLI entry point reaches. Each
    // resolves the club day before its transaction opens.
    "src/lib/booking-request.ts",
    "src/lib/booking-request-quotes.ts",
    "src/lib/school-booking-request.ts",
    "src/lib/group-booking.ts",
    "src/lib/waitlist-cross-lodge.ts",
  ],
} as const;

/**
 * The modules whose lock-bound functions ONLY ever run on a caller's
 * transaction client. They take `today` and resolve NOTHING, which is what
 * makes the threading real rather than decorative: a reader added back into one
 * of these is under a lock by construction, whatever the caller did, because
 * there is no "before the transaction" reachable from in here.
 *
 * `bed-allocation-date-range.ts` is the last entry and reaches the same
 * conclusion from the other direction (#3123). It never receives a transaction
 * client at all — it is SYNCHRONOUS, so it cannot await a database read without
 * first becoming `async` and dragging its four callers with it, and its product
 * is what the locked approve and auto-allocate writers act on. "Resolve nothing"
 * is therefore the same rule here, and banning the readers keeps the `async`
 * shortcut shut.
 */
const PURE_CALLEES = [
  "src/lib/bed-allocation-lifecycle.ts",
  "src/lib/adult-member-hosting-review.ts",
  "src/lib/booking-guest-removal-service.ts",
  "src/lib/lodge-deactivation-guard.ts",
  "src/lib/bed-allocation-date-range.ts",
  // The money callees (#3123). All three run on a caller's transaction client
  // with `pg_advisory_xact_lock(1)` and the per-lodge capacity key already held,
  // and all three take the club's day as a required parameter:
  // `calculateModificationSettlementOptions` (the reduction refund's tier),
  // `applyPromoCodeChanges` + `calculateModificationChangeFee`, and
  // `resolvePromoInTransaction` — which additionally holds a `FOR UPDATE` lock
  // on the promo row itself by the time it needs the day.
  "src/lib/booking-modify-settlement.ts",
  "src/lib/booking-modify-plan.ts",
  "src/lib/booking-create-promo.ts",
  // The person-night callees (#3123 review). `buildApprovalGuestCreates` runs on
  // the caller's `tx` in all three approval pipelines;
  // `booking-batch-modification-service.ts` is here for a subtler reason and is
  // the whole point of the caller-transaction rule below — it is transaction
  // AWARE, so even a read at the very top of `modifyBookingBatch` is inside a
  // transaction whenever the policy-exception approval supplies one. "Resolve
  // nothing" is the only rule that holds on every path in.
  "src/lib/booking-request-shared.ts",
  "src/lib/booking-batch-modification-service.ts",
] as const;

/**
 * The two bed-inventory modules are BOTH — their `…WithLocksHeld` writers take
 * `today`, and the public wrapper in the same file is the caller that opens the
 * transaction and resolves it. So they are exempt from "resolve nothing" and
 * covered instead by the transaction-span rule, which is the stronger check:
 * it fails on a read in the wrong PLACE rather than on a read at all.
 */
const DUAL_ROLE_CALLEES = [
  "src/lib/bed-allocation-beds.ts",
  "src/lib/bed-allocation-rooms.ts",
] as const;

/**
 * Callees that resolve NOTHING, exactly like `PURE_CALLEES`, but which are
 * deliberately kept OUT of the legacy-spelling rule at the bottom of this file
 * (#3123).
 *
 * The reason is the one `club-time-escape-hatch-census.test.ts` learned the hard
 * way and wrote down: this repository documents each defect it removes AT the
 * site where it removed it, so the strings a plain-text scan greps for are
 * densest in exactly the files that no longer commit the defect. Both of these
 * carry a docblock naming `normalizeDateOnlyForTimeZone` and `APP_TIME_ZONE` in
 * order to explain what was wrong and why the parameter is required — and the
 * spelling rule here is a `source.includes`, with no comment stripping. Adding
 * them to `CALLEES` would fail this suite on its own postmortems.
 *
 * What actually governs the CALLS in these two files is the census ceiling,
 * which strips comments and which both of them are now at zero on. What this
 * group adds is the rule the census cannot express: that neither file ever
 * resolves the club's zone for itself.
 */
const VALUE_ONLY_CALLEES = [
  "src/lib/policies/cancellation.ts",
  "src/lib/policies/booking-route-decisions.ts",
  // The person-night guard itself, and the policy-exception approval executor
  // that drives both transaction-aware services (#3123 review). Both are here
  // rather than in `PURE_CALLEES` for the reason this group exists: each carries
  // a docblock naming `APP_TIME_ZONE` in order to explain the defect it stopped
  // committing, and the spelling rule below is a comment-blind `source.includes`.
  // What matters for them is that neither resolves the club's zone for itself —
  // which is exactly what this group asserts.
  "src/lib/booking-member-night-conflicts.ts",
  "src/lib/booking-exception-approval.ts",
  // The member-guest consent expiry clamp (#3123, group F), and it is here
  // rather than in `PURE_CALLEES` for exactly the reason above: its docblock
  // names `normalizeDateOnlyForTimeZone` in order to explain the projection it
  // stopped doing, and the spelling rule is a comment-blind `source.includes`.
  // `planMemberGuestConsentWrites` calls it from inside booking transactions
  // holding the global lock and the lodge capacity key, so what matters here is
  // that it resolves nothing for itself — which this group is what asserts.
  "src/lib/member-guest-consent.ts",
] as const;

const CALLEES = [...PURE_CALLEES, ...DUAL_ROLE_CALLEES];

const ALL_RESOLVERS = [...RESOLVERS.serverBinding, ...RESOLVERS.runtimeReader];

/** Any call that ends in a `clubTimeSettings` query. */
const CLUB_ZONE_READERS = [
  "readClubTimeZoneOutsideRequest(",
  "resolveClubTimeZoneOutsideRequest(",
  "clubTodayDateOnlyInstant(",
  "clubTimeZone(",
  "clubTime(",
  "getClubTimeZone(",
] as const;

/** The legacy environment-zone spellings this issue retires. */
const ENVIRONMENT_ZONE_SPELLINGS = [
  "getTodayDateOnly(",
  "normalizeDateOnlyForTimeZone(",
  "todayDateOnlyForTimeZone(",
  "APP_TIME_ZONE",
] as const;

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), "utf8");
}

/**
 * Every tracked production source file under `src/`, read once.
 *
 * Same walk shape as `club-time-escape-hatch-census.test.ts`, and here for the
 * reason Finding 3 of the #3123 delta review gave: the two populations this file
 * polices — which wrappers open a transaction, and which files call the
 * caller-transaction one — were both REMEMBERED, so a new member of either was
 * simply not covered and nothing said so. They are derived from the tree below,
 * and the hand-written lists above are then a second instrument that can only
 * agree with the scan by both being right.
 */
function walkProductionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") {
        walkProductionSources(full, out);
      }
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
    ) {
      out.push(path.relative(REPO_ROOT, full).replaceAll("\\", "/"));
    }
  }
  return out;
}

const PRODUCTION_SOURCES: ReadonlyMap<string, string> = new Map(
  walkProductionSources(path.join(REPO_ROOT, "src")).map((file) => [
    file,
    read(file),
  ]),
);

/**
 * Every call that OPENS a transaction whose callback body then runs inside it.
 *
 * `$transaction(` is the obvious one. `withOptionalTransaction(` is the one the
 * #3123 review caught this guard missing, and it is worth stating why the miss
 * mattered: `src/lib/db-transaction.ts` runs its callback inside the caller's
 * `tx` when one is supplied and opens `prisma.$transaction` otherwise, so its
 * callback body is inside a transaction on BOTH paths while containing the
 * literal `$transaction(` on NEITHER. A detector keyed on one spelling reported
 * green over exactly the wrapper it existed to police.
 *
 * `withBoundedReadOnlyTransaction(` is the one the DELTA review caught this
 * guard still missing, and it matters for the same reason twice over. It opens a
 * real `prisma.$transaction` at `RepeatableRead` under a statement timeout
 * (`src/lib/diagnostics/tools/read-only-transaction.ts`), so its callback body is
 * inside a transaction while containing the literal `$transaction(` nowhere — and
 * it is the exact wrapper `booking-evidence.ts` had been hiding behind before the
 * fix. With it absent, moving that file's `clubTodayDateOnlyInstant()` back inside
 * the callback — the precise pre-fix `INV-LOCK-004` violation — produced ZERO
 * offenders: rule 2 keys only on `withOptionalTransaction`, rules 3 and 6 do not
 * cover resolvers, and rule 4 still saw a read somewhere in the file. Adding it
 * makes the mutation fail loudly and names the site.
 *
 * WHY THE OPENER SET IS THE WHOLE POPULATION AND NOT A SAMPLE. Both members were
 * found only after each had already let a real defect through, so the set is
 * derived rather than remembered: a scan of every tracked non-test source file
 * for a function-like declaration whose body contains `$transaction(` and whose
 * parameters include a function-typed one returns exactly these two. Re-run that
 * scan whenever a transaction helper is added — a wrapper this list has not heard
 * of is a span this file cannot see into.
 */
const TRANSACTION_OPENERS = [
  "$transaction(",
  "withOptionalTransaction(",
  "withBoundedReadOnlyTransaction(",
] as const;

/**
 * The body of every transaction-opening call's argument list in a source file,
 * with the line the call starts on.
 *
 * Comments and string literals are skipped so an opener inside either cannot
 * open a phantom span, and a bracket inside either cannot close a real one.
 * Same shape as `payment-link-expiry-club-zone.test.ts`'s scanner, and
 * deliberately not a parser.
 */
function transactionCallbackSpans(
  source: string,
): Array<{ line: number; body: string }> {
  const spans: Array<{ line: number; body: string }> = [];
  for (const needle of TRANSACTION_OPENERS) {
    spans.push(...spansForOpener(source, needle));
  }
  return spans;
}

function spansForOpener(
  source: string,
  NEEDLE: string,
): Array<{ line: number; body: string }> {
  const spans: Array<{ line: number; body: string }> = [];

  for (
    let at = source.indexOf(NEEDLE);
    at !== -1;
    at = source.indexOf(NEEDLE, at + 1)
  ) {
    const open = at + NEEDLE.length - 1;
    let depth = 0;
    let end = -1;

    for (let i = open; i < source.length; i++) {
      const c = source[i];
      const next = source[i + 1];

      if (c === "/" && next === "/") {
        const nl = source.indexOf("\n", i);
        i = nl === -1 ? source.length : nl;
        continue;
      }
      if (c === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? source.length : close + 1;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i += 1;
        for (; i < source.length; i++) {
          if (source[i] === "\\") {
            i += 1;
            continue;
          }
          if (source[i] === quote) break;
        }
        continue;
      }

      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) continue;
    spans.push({
      line: source.slice(0, at).split("\n").length,
      body: source.slice(open + 1, end),
    });
  }

  return spans;
}

/**
 * The callback-opening wrappers whose ENCLOSING FUNCTION is inside a transaction
 * whenever a caller supplies one. Today that is `withOptionalTransaction`, whose
 * whole reason for existing is that the caller may already have opened the
 * transaction (#2525).
 */
const CALLER_TRANSACTION_WRAPPERS = ["withOptionalTransaction("] as const;

/** Column-0 declarations, which is where this codebase's exported services live. */
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\b/gm;

/**
 * Comments and string/template literals blanked to spaces, with every offset and
 * newline preserved, so a regex or an `indexOf` over the result reports
 * positions that are still valid in the original.
 */
function blankCommentsAndStrings(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      const end = nl === -1 ? source.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(i, end);
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      for (; j < source.length; j++) {
        if (source[j] === "\\") {
          j += 1;
          continue;
        }
        if (source[j] === quote) break;
      }
      blank(i, Math.min(j + 1, source.length));
      i = j;
      continue;
    }
  }

  return out.join("");
}

/**
 * The WHOLE BODY of every top-level declaration that hands a caller-supplied
 * transaction to a wrapper — because on that path the transaction is already
 * open when control enters the function, so "above the wrapper call" is not
 * "outside the transaction".
 *
 * This is the rule the #3123 review's Finding 2 needed and the span scanner
 * above could never express. `modifyBookingBatch` read the club's zone at its
 * own line 375, thirteen lines ABOVE `withOptionalTransaction(callerTx, …)`,
 * and every lexical check agreed that was outside the transaction. It was not:
 * `approveAndExecutePolicyExceptionRequest` calls that service with ITS
 * transaction, holding `pg_advisory_xact_lock(1)` and the per-lodge capacity
 * key, so the read took a second pooled connection under both. There is no
 * position inside such a function that is outside the transaction on every path
 * in, which is why the only rule that holds is "resolve nothing here at all"
 * and the day arrives as a required parameter.
 *
 * The boundary heuristic is column-0 declarations rather than a parser, for the
 * reason the file gives above. Getting it wrong can only make a span LARGER —
 * a missed boundary merges two declarations — so it fails towards refusing a
 * read, never towards permitting one.
 */
function callerTransactionSpans(
  source: string,
): Array<{ line: number; body: string }> {
  const masked = blankCommentsAndStrings(source);
  const starts = [...masked.matchAll(TOP_LEVEL_DECLARATION)].map(
    (match) => match.index ?? 0,
  );
  const seen = new Set<number>();
  const spans: Array<{ line: number; body: string }> = [];

  for (const wrapper of CALLER_TRANSACTION_WRAPPERS) {
    for (
      let at = masked.indexOf(wrapper);
      at !== -1;
      at = masked.indexOf(wrapper, at + 1)
    ) {
      let start = 0;
      for (const candidate of starts) {
        if (candidate <= at) start = candidate;
        else break;
      }
      if (seen.has(start)) continue;
      seen.add(start);
      const end = starts.find((candidate) => candidate > start) ?? source.length;
      spans.push({
        line: source.slice(0, start).split("\n").length,
        body: source.slice(start, end),
      });
    }
  }

  return spans;
}

/**
 * A function-like declaration head, in either spelling this codebase uses:
 * `function name(` and `const name = (`, with or without `export`, `async` and a
 * type parameter list. Deliberately not a parser, for the reason this file gives
 * above — and it only has to be good enough to FIND a wrapper, because a wrapper
 * it finds and cannot classify fails the census loudly rather than quietly.
 */
const FUNCTION_DECLARATION =
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(|(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=\n]*)?=\s*(?:async\s+)?(?:<[^>]*>)?\s*\(/g;

/** The index of the bracket closing the one at `from`, or -1. */
function closingBracket(
  source: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The name of every function in this source that OPENS a transaction behind its
 * own name: it takes a callback parameter and its body calls `$transaction(`.
 *
 * This is the instrument that stops `TRANSACTION_OPENERS` being a memory.
 * `withOptionalTransaction` and `withBoundedReadOnlyTransaction` were each found
 * only AFTER it had let a real `INV-LOCK-004` violation through a green suite —
 * the first in the #3123 review, the second in the delta review of that fix — so
 * waiting for the third to announce itself the same way is not a plan.
 *
 * Brackets are matched on the comment-and-string-masked source so a brace in a
 * docblock or a template literal cannot move a boundary.
 */
function transactionWrapperNames(source: string): string[] {
  const masked = blankCommentsAndStrings(source);
  if (!masked.includes("$transaction(")) return [];
  const names: string[] = [];

  for (const match of masked.matchAll(FUNCTION_DECLARATION)) {
    const name = match[1] ?? match[2];
    const paramsOpen = (match.index ?? 0) + match[0].length - 1;
    const paramsEnd = closingBracket(masked, paramsOpen, "(", ")");
    if (paramsEnd === -1) continue;

    // A callback parameter — the thing that makes this a wrapper rather than a
    // function that merely happens to use a transaction internally.
    if (!masked.slice(paramsOpen + 1, paramsEnd).includes("=>")) continue;

    const bodyOpen = masked.indexOf("{", paramsEnd);
    if (bodyOpen === -1) continue;
    const bodyEnd = closingBracket(masked, bodyOpen, "{", "}");
    const body = masked.slice(bodyOpen, bodyEnd === -1 ? masked.length : bodyEnd);
    if (body.includes("$transaction(")) names.push(name);
  }

  return names;
}

/** `withOptionalTransaction` -> `withOptionalTransaction`. */
const CALLER_TRANSACTION_WRAPPER_NAMES = CALLER_TRANSACTION_WRAPPERS.map(
  (wrapper) => wrapper.slice(0, -1),
);

/**
 * Every production file that CALLS a caller-transaction wrapper — the population
 * rule 2 has to run over, derived rather than remembered.
 *
 * The file that DEFINES the wrapper is not a caller of it. It is excluded by its
 * declaration rather than by path, so moving `db-transaction.ts` does not
 * silently turn its own definition into an offender.
 */
function callerTransactionWrapperCallers(): string[] {
  const callers: string[] = [];

  for (const [file, source] of PRODUCTION_SOURCES) {
    const masked = blankCommentsAndStrings(source);
    if (!CALLER_TRANSACTION_WRAPPERS.some((call) => masked.includes(call))) {
      continue;
    }
    const defines = CALLER_TRANSACTION_WRAPPER_NAMES.some((name) =>
      new RegExp(`function\\s+${name}\\b`).test(masked),
    );
    if (!defines) callers.push(file);
  }

  return callers;
}

/**
 * The files rule 2 runs over: the hand-classified set, UNION every caller the
 * scan above found. The union is what makes a new call site covered from the
 * moment it is written; the assertion in "the guard's populations are derived
 * from the tree" is what makes somebody classify it into the right list, so the
 * grouping rules 3 to 6 depend on stay true.
 */
const CALLER_TRANSACTION_POPULATION = [
  ...new Set([
    ...ALL_RESOLVERS,
    ...PURE_CALLEES,
    ...DUAL_ROLE_CALLEES,
    ...VALUE_ONLY_CALLEES,
    ...callerTransactionWrapperCallers(),
  ]),
];

describe("the club's day is resolved outside the locks and threaded in (#3123)", () => {
  it("reads the club's zone outside every transaction, in every resolver", () => {
    const offenders: string[] = [];

    for (const file of ALL_RESOLVERS) {
      const source = read(file);
      for (const span of transactionCallbackSpans(source)) {
        for (const reader of CLUB_ZONE_READERS) {
          if (span.body.includes(reader)) {
            offenders.push(`${file}:${span.line} (${reader})`);
          }
        }
      }
    }

    expect(
      offenders,
      "A club-zone read inside a `$transaction` callback holds a " +
        "`clubTimeSettings` query under whatever that transaction locked — " +
        "`pg_advisory_xact_lock(1)`, every affected lodge capacity key, and on " +
        "the merge path a `Member … FOR UPDATE` held for up to 120 seconds. " +
        "Resolve the club's day BEFORE the transaction and pass it in as the " +
        "required `today`: `INV-LOCK-004`, and " +
        "`docs/CONCURRENCY_AND_LOCKING.md` -> \"Which client reads the club's " +
        'timezone".',
    ).toEqual([]);
  });

  it("a transaction-AWARE service resolves nothing anywhere in its body", () => {
    // Finding 2 of the #3123 review, and the hole that let it through. See
    // `callerTransactionSpans` for the full reasoning.
    const offenders: string[] = [];

    for (const file of CALLER_TRANSACTION_POPULATION) {
      const source = read(file);
      for (const span of callerTransactionSpans(source)) {
        for (const reader of CLUB_ZONE_READERS) {
          if (span.body.includes(reader)) {
            offenders.push(`${file}:${span.line} (${reader})`);
          }
        }
      }
    }

    expect(
      offenders,
      "This function hands a CALLER-SUPPLIED transaction to " +
        "`withOptionalTransaction`, so on that path the transaction is already " +
        "open when control enters it — a club-zone read ANYWHERE in the body, " +
        "including above the wrapper call, runs a `clubTimeSettings` query on " +
        "the module client and takes a SECOND pooled connection under " +
        "`pg_advisory_xact_lock(1)` and the per-lodge capacity key the caller " +
        "already holds. With the pool at N and N such writers in flight they " +
        "all reach `pool_timeout`, and the zone reader is fail-soft, so the " +
        "symptom is the WRONG club day rather than an error. There is no " +
        'position in such a function that is outside the transaction on every ' +
        "path: take the day as a required parameter instead (`INV-LOCK-004`).",
    ).toEqual([]);
  });

  it("the guard's populations are derived from the tree, not remembered", () => {
    // Finding 3 of the #3123 DELTA review. Both lists this file scans with were
    // hand-maintained, and nothing compared either against the tree — so a new
    // transaction wrapper, or a new caller of the caller-transaction one, was
    // simply not covered and the suite stayed green about it. Two instruments
    // that can only agree by both being right.
    const unlistedWrappers: string[] = [];
    let wrappersFound = 0;

    for (const [file, source] of PRODUCTION_SOURCES) {
      for (const name of transactionWrapperNames(source)) {
        wrappersFound += 1;
        if (!(TRANSACTION_OPENERS as readonly string[]).includes(`${name}(`)) {
          unlistedWrappers.push(`${file} (${name})`);
        }
      }
    }

    expect(
      unlistedWrappers,
      "This function opens a `$transaction` behind its own name and takes a " +
        "callback, so its callback body is inside a transaction while " +
        "containing the literal `$transaction(` nowhere — and " +
        "`TRANSACTION_OPENERS` has not heard of it, which means the " +
        "outside-the-transaction rule cannot see into a single one of its " +
        "spans. Add it there. This is how `withOptionalTransaction` and " +
        "`withBoundedReadOnlyTransaction` each hid a real `INV-LOCK-004` " +
        "violation behind a green suite, and the point of this check is that " +
        "the third one is caught the day it is written instead.",
    ).toEqual([]);

    // Vacuity: a scanner that stopped matching would report no unlisted
    // wrappers just as loudly as a clean tree.
    expect(wrappersFound).toBeGreaterThanOrEqual(2);

    const unclassifiedCallers = callerTransactionWrapperCallers().filter(
      (file) =>
        !(
          [
            ...ALL_RESOLVERS,
            ...PURE_CALLEES,
            ...DUAL_ROLE_CALLEES,
            ...VALUE_ONLY_CALLEES,
          ] as readonly string[]
        ).includes(file),
    );

    expect(
      unclassifiedCallers,
      `This file calls ${CALLER_TRANSACTION_WRAPPER_NAMES.join(", ")} and is ` +
        "named in none of the lists at the top of this suite. The rule above " +
        "already covers it — the population is the union — but the lists are " +
        "what the OTHER rules run over, and which list a file belongs in is a " +
        "real decision: a resolver reads the club's zone and is checked for " +
        "the right reader, a callee resolves nothing at all. Put it in one " +
        "(`INV-LOCK-004`).",
    ).toEqual([]);
  });

  it("the callees resolve nothing at all — they only take the day they are given", () => {
    const offenders: string[] = [];

    for (const file of [...PURE_CALLEES, ...VALUE_ONLY_CALLEES]) {
      const source = read(file);
      for (const reader of CLUB_ZONE_READERS) {
        if (source.includes(reader)) offenders.push(`${file} (${reader})`);
      }
    }

    expect(
      offenders,
      "These modules run on the CALLER's transaction client with its locks " +
        "already held, so any zone read added to one of them is under a lock " +
        "by construction — there is no 'before the transaction' available from " +
        "in here. The day arrives as a required `today` parameter instead " +
        "(#3123, `INV-LOCK-004`).",
    ).toEqual([]);
  });

  it("every resolver still reads the club's zone — a deleted read passes the rule above", () => {
    const silent = ALL_RESOLVERS.filter((file) => {
      const source = read(file);
      return !CLUB_ZONE_READERS.some((reader) => source.includes(reader));
    });

    expect(
      silent,
      "A file that threads `new Date()`, a fixture constant or nothing at all " +
        "into `today` satisfies the outside-the-transaction rule perfectly and " +
        "is still wrong: `INV-CONFIG-002` says the day comes from the club's " +
        "PERSISTED timezone. Each of these files must call one of " +
        `${CLUB_ZONE_READERS.join(", ")}.`,
    ).toEqual([]);
  });

  it("each resolver takes the reader its reach entitles it to", () => {
    const wrongReader: string[] = [];

    for (const file of RESOLVERS.runtimeReader) {
      // Matched as an IMPORT (`from "…"`), not as bare text (#3123). Several of
      // these files explain in a docblock why they cannot import
      // `@/lib/club-time/server` — `promo.ts` says so in as many words — and a
      // substring match failed those files on their own reasoning. The same
      // trap the census records under "a census that counts its own
      // postmortems".
      if (/from\s+["']@\/lib\/club-time\/server["']/.test(read(file))) {
        wrongReader.push(`${file} imports the server-only binding`);
      }
    }

    expect(
      wrongReader,
      "`@/lib/club-time/server` carries `import \"server-only\"`, a bare throw " +
        "outside the `react-server` condition. These files are reachable from a " +
        "CLI entry point or from `src/instrumentation.node.ts`, so importing it " +
        "kills the script or the cron tick at import, before it runs. Compose " +
        "`dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()))` " +
        'instead — `docs/CLUB_TIME_KERNEL.md` -> "Where the zone comes from".',
    ).toEqual([]);
  });

  it("no legacy environment-zone helper survives in the pure callees", () => {
    /*
      Scoped to the callees, deliberately, and with no allowlist. The RESOLVER
      files are ordinary modules with their own unrelated temporal surfaces —
      `seasonal-membership-assignments.ts` still carries a `getTodayDateOnly()`
      in its change-preview path, which is a different #3123 site on a different
      lane — and policing them from here would mean an exemption list that rots.
      What governs those is the census ceiling in
      `club-time-escape-hatch-census.test.ts`, which may only ever fall.
    */
    const offenders: string[] = [];

    for (const file of CALLEES) {
      const source = read(file);
      for (const spelling of ENVIRONMENT_ZONE_SPELLINGS) {
        if (source.includes(spelling)) offenders.push(`${file} (${spelling})`);
      }
    }

    expect(
      offenders,
      "`getTodayDateOnly()` and friends default their zone to `APP_TIME_ZONE`, " +
        "the container's, which is the defect #3123 exists to remove " +
        "(`INV-CONFIG-002`). These seven modules are at zero and may not " +
        "regrow; the census ceiling in " +
        "`club-time-escape-hatch-census.test.ts` counts what is left elsewhere.",
    ).toEqual([]);
  });

  it("NOT VACUOUS: the scanner found real transactions and real readers", () => {
    // Without this, a renamed `$transaction`, a moved file or a scanner that
    // silently stopped matching would leave every assertion above passing over
    // nothing at all.
    const spans = ALL_RESOLVERS.flatMap((file) =>
      transactionCallbackSpans(read(file)),
    );
    expect(spans.length).toBeGreaterThanOrEqual(15);
    for (const span of spans) expect(span.body.length).toBeGreaterThan(0);

    // The caller-transaction scanner is separately losable: it keys on a
    // DIFFERENT needle and on a different boundary heuristic, so a renamed
    // wrapper or a reformat that moves a declaration off column 0 would leave
    // its rule passing over nothing. Two files in the tree hand a caller
    // transaction to `withOptionalTransaction` — `booking-create.ts` and
    // `booking-batch-modification-service.ts` — and the derived population is
    // what finds them, with the lists above agreeing that both are classified.
    const callerSpans = CALLER_TRANSACTION_POPULATION.flatMap((file) =>
      callerTransactionSpans(read(file)),
    );
    expect(callerSpans.length).toBeGreaterThanOrEqual(2);
    for (const span of callerSpans) {
      expect(span.body).toContain("withOptionalTransaction(");
      expect(span.body.length).toBeGreaterThan(200);
    }

    // The widened opener set really recognises the wrapper, not just
    // `$transaction(`. Proved on a synthetic source, because both real
    // files that use it are also covered by the stronger whole-function
    // rule above, so this half could never be seen failing on its own.
    const wrapped = transactionCallbackSpans(
      [
        "async function writer(callerTx) {",
        "  return withOptionalTransaction(callerTx, async (tx) => {",
        "    return clubTimeZone();",
        "  });",
        "}",
      ].join("\n"),
    );
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].body).toContain("clubTimeZone()");

    // And the same for the read-only wrapper, which is the one the DELTA review
    // proved invisible: with it absent from the opener set, restoring
    // `booking-evidence.ts`'s pre-fix shape produced ZERO offenders.
    const bounded = transactionCallbackSpans(
      [
        "async function evidence(bookingId) {",
        "  return withBoundedReadOnlyTransaction(async (tx) =>",
        "    read(bookingId, tx, await clubTodayDateOnlyInstant()),",
        "  );",
        "}",
      ].join("\n"),
    );
    expect(bounded).toHaveLength(1);
    expect(bounded[0].body).toContain("clubTodayDateOnlyInstant()");

    // And the masker it is built on really blanks a comment while preserving
    // every offset — the property that lets a docblock naming a reader sit in a
    // transaction-aware function without tripping the rule, and that stops a
    // brace inside a string from moving a boundary.
    const masked = blankCommentsAndStrings(
      'const a = 1; // clubTime(\nconst b = "clubTime(";\n',
    );
    expect(masked).toHaveLength('const a = 1; // clubTime(\nconst b = "clubTime(";\n'.length);
    expect(masked).not.toContain("clubTime(");
    expect(masked.split("\n")).toHaveLength(3);
  });
});
