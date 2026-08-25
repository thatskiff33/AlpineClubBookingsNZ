// #3110 — which Prisma client reads the cancellation and non-member-hold policy
// set, read off the real source files.
//
// ENFORCES `INV-LOCK-004` (`docs/invariants/operations.md`): **a read taken
// while a lock is held goes through the caller's transaction client, never the
// module-level one** → so a caller already inside `prisma.$transaction` MUST
// pass its own `tx`. Every assertion below repeats that id in its failure
// message, so whoever trips one is handed the rule instead of having to go and
// find it (`AGENTS.md` → "Keeping the table usable"). The reasoning and the
// writer inventory are in `docs/CONCURRENCY_AND_LOCKING.md` → "Which client
// reads the cancellation and non-member-hold policy".
//
// The id was minted BY this change, and that is the point: before it, the
// nearest-looking ids were `INV-LOCK-001` (which lock TIER a writer takes),
// `-002` (the order) and `-003` (registering a global site), none of which state
// this rule. An earlier draft of this file cited `-001` and `docs:indexcheck`
// passed it, because that check verifies a cited id RESOLVES and never that the
// prose beside it says what the citation claims → which is the defect #3080
// spent 37 files repairing. A rule with no id is what pushes a guard toward the
// nearest wrong one, so the rule got an id rather than a pointer.
//
// WHY STRUCTURAL AND NOT BEHAVIOURAL. The defect is a claim about a SET OF CALL
// SITES, and it is invisible to any test of what the sites return:
//
//   * reading the policy set on the module client while holding
//     `pg_advisory_xact_lock(1)` and the per-lodge capacity lock checks out a
//     SECOND pool connection underneath both locks. Under load every connection
//     can end up held by a transaction waiting for a connection. The answer the
//     read produces is identical either way, so a behavioural test of any one
//     site passes just as green before the fix as after it;
//   * the failure is load-dependent and has never been observed directly, which
//     is exactly why a test rather than an observation has to close it;
//   * nine sites were found, and the fix landed nine edits. Nine behavioural
//     tests would leave a TENTH call site free to reappear — which is how these
//     nine came to exist while the remediated sibling `validateMinimumStay` sat
//     two files away, correctly parameterised and pinned. Both assertions below
//     are therefore derived from the source, with NO allowlist of sites: a new
//     in-transaction call site is caught the day it is written.
//
// This is the remedy shape PR #3105 chose for the same reason — a source
// contract over the writers, where no runtime guard could be built.
//
// Mirrors the convention in adult-member-hosting-call-sites.test.ts (#2569) and
// subscription-lockout-call-sites.test.ts (#2543).
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The three readers of the booking policy set. All three take
 * `(checkIn, lodgeId, db)`, so "passes a client" means a third argument at every
 * one of them.
 *
 * `getNonMemberHoldDays` is included even though all of its call sites are
 * currently outside a transaction. It is the third reader of the same policy set
 * — it delegates to `getNonMemberHoldPolicy` — and leaving it out would let the
 * class return through the one door this file did not watch.
 */
const READERS = [
  "getNonMemberHoldPolicy",
  "getNonMemberHoldDays",
  "loadCancellationPolicy",
] as const;

/**
 * Every way this repository opens a transaction, as a lexical marker.
 *
 * `withOptionalTransaction` (`db-transaction.ts`) is the one that matters and the
 * one a scan built only from `prisma.$transaction(` misses: it either reuses a
 * caller's `tx` or opens its own, so its callback body always runs inside a
 * transaction. `modifyBookingBatch` reaches two of this issue's nine sites
 * through it, and a `prisma.$transaction(`-only scan reports both as safe.
 */
const TX_OPENERS = [
  "prisma.$transaction(",
  "$transaction(",
  "withOptionalTransaction(",
] as const;

const RULE =
  "INV-LOCK-004 (docs/invariants/operations.md): a read taken while a lock is " +
  "held goes through the caller's transaction client, never the module one. A " +
  "caller already inside prisma.$transaction MUST pass its own tx to the " +
  "policy readers; reading on the module client there checks out a second pool " +
  "connection underneath pg_advisory_xact_lock(1) and the per-lodge capacity " +
  "lock. Explanation: docs/CONCURRENCY_AND_LOCKING.md -> \"Which client reads " +
  "the cancellation and non-member-hold policy\".";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

/**
 * The same source with its comments removed.
 *
 * Every sweep below is a claim about CODE, and this repository comments heavily:
 * the fix for this very issue wrote `prisma.$transaction` into a dozen
 * explanatory comments beside the call sites it corrected. A plain text search
 * reads those as transaction openers and the assertions become the opposite of
 * what they say.
 *
 * Block comments and whole-line `//` comments only: a trailing comment on a line
 * of code is left alone rather than risking a `//` inside a string literal.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** Index of the `)` closing the `(` at `openIndex`, or -1. */
function matchParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `[start, end]` character spans of every transaction callback in one file. */
function transactionSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const opener of TX_OPENERS) {
    let index = -1;
    while ((index = code.indexOf(opener, index + 1)) !== -1) {
      const close = matchParen(code, index + opener.length - 1);
      if (close > -1) spans.push([index, close]);
    }
  }
  return spans;
}

const FUNCTION_DECLARATION = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;

/**
 * The nearest enclosing top-level function declaration's name and PARAMETER
 * LIST, for the call at `offset`.
 *
 * The parameter list only — not the body up to the call. A function that merely
 * *uses* a `tx` from an outer closure is not a transaction-scoped helper, and
 * slicing the body would read every nested arrow function's own `tx` as this
 * function's parameter.
 */
function enclosingFunction(
  code: string,
  offset: number,
): { name: string; params: string } | null {
  FUNCTION_DECLARATION.lastIndex = 0;
  let best: { name: string; parenOpen: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = FUNCTION_DECLARATION.exec(code))) {
    if (match.index > offset) break;
    best = { name: match[1], parenOpen: match.index + match[0].length - 1 };
  }
  if (!best) return null;
  const close = matchParen(code, best.parenOpen);
  if (close === -1) return null;
  return { name: best.name, params: code.slice(best.parenOpen, close + 1) };
}

/**
 * True when a parameter list declares a Prisma client the body can pass on —
 * either a positional `tx: Prisma.TransactionClient` or a destructured
 * `db: CancellationPolicyDb` field. Matches the NAME followed by its type
 * annotation, so a parameter merely *starting* with those letters (`dbUrl:`,
 * `txId:`) is not a match.
 */
function declaresClientParameter(params: string): boolean {
  return /\b(?:tx|db)\s*\??\s*:/.test(params);
}

/** Top-level (depth-0) argument count for a call whose `(` is at `openIndex`. */
function argumentList(code: string, openIndex: number): string[] {
  const close = matchParen(code, openIndex);
  const inner = code.slice(openIndex + 1, close);
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) args.push(current);
  return args.map((a) => a.trim()).filter((a) => a.length > 0);
}

/** Every non-test source file under `src/`, as repo-relative POSIX paths. */
function sourceFiles(): string[] {
  const root = path.resolve(process.cwd(), "src");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "__tests__") walk(full);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        found.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

type CallSite = {
  file: string;
  line: number;
  reader: string;
  args: string[];
  insideTransaction: boolean;
  enclosing: { name: string; params: string } | null;
};

/**
 * Every call of the three readers in non-test source, classified. Computed once:
 * the walk is over the whole tree and each assertion below would otherwise
 * repeat it (the 9 s-under-parallel-load trap #2569 documents).
 */
const CALL_SITES: CallSite[] = (() => {
  const sites: CallSite[] = [];
  for (const file of sourceFiles()) {
    const raw = readRepoFile(file);
    if (!READERS.some((reader) => raw.includes(`${reader}(`))) continue;
    const code = stripComments(raw);
    const spans = transactionSpans(code);
    const lines = code.split("\n");
    for (const reader of READERS) {
      let index = -1;
      while ((index = code.indexOf(`${reader}(`, index + 1)) !== -1) {
        const line = code.slice(0, index).split("\n").length;
        // The declaration itself, and re-export/import mentions, are not calls.
        if (/^\s*(?:export\s+)?(?:async\s+)?function\s/.test(lines[line - 1])) {
          continue;
        }
        sites.push({
          file,
          line,
          reader,
          args: argumentList(code, index + reader.length),
          insideTransaction: spans.some(([s, e]) => index > s && index < e),
          enclosing: enclosingFunction(code, index),
        });
      }
    }
  }
  return sites;
})();

/** The third argument, i.e. the client, or null when the call passes none. */
function clientArgument(site: CallSite): string | null {
  return site.args.length >= 3 ? site.args[2] : null;
}

describe("which client reads the cancellation policy set (#3110)", () => {
  it("finds the call sites at all, so nothing below can pass vacuously", () => {
    // A rename, a moved file or a broken walk would empty every sweep and turn
    // this whole file green while enforcing nothing. Pin the shape of the
    // census, not its exact size — the counts move with ordinary work.
    expect(CALL_SITES.length).toBeGreaterThanOrEqual(18);
    for (const reader of READERS) {
      expect(
        CALL_SITES.filter((s) => s.reader === reader).length,
        `no call sites found for ${reader}: the census is not reading the tree`,
      ).toBeGreaterThan(0);
    }
    expect(
      CALL_SITES.filter((s) => s.insideTransaction).length,
      "no in-transaction call site found: the transaction-span scan is broken, " +
        "so the assertion below cannot fail",
    ).toBeGreaterThan(0);
    // And the same for Part B's population. Its filter is narrower than Part
    // A's and an empty one is silent: the assertion iterates nothing and the
    // test passes. This is the "guard can be vacuous" failure mode this epic
    // measured twice, so the population is asserted rather than assumed.
    expect(
      CALL_SITES.filter(
        (s) =>
          !s.insideTransaction &&
          s.enclosing !== null &&
          declaresClientParameter(s.enclosing.params),
      ).length,
      "no call site found inside a client-taking helper: Part B is vacuous",
    ).toBeGreaterThan(0);
  });

  it("passes a transaction client at every call site inside a transaction", () => {
    // Part A — lexical, and deliberately allowlist-free, so a TENTH site is
    // caught the day it is written rather than by the next audit.
    for (const site of CALL_SITES.filter((s) => s.insideTransaction)) {
      const client = clientArgument(site);
      const where = `${site.file}:${site.line} ${site.reader}(...)`;
      expect(client, `${where} passes no client. ${RULE}`).not.toBeNull();
      // And not the module client smuggled in to satisfy an argument count —
      // which is the mutant this assertion exists to kill.
      expect(
        client,
        `${where} passes the module client explicitly from inside a ` +
          `transaction, which is the very read being forbidden. ${RULE}`,
      ).toMatch(/^(?:tx|db)\b/);
    }
  });

  it("passes it on at every call site inside a transaction-scoped helper", () => {
    // Part B — the indirect class, and the half a lexical scan cannot see.
    // Three of this issue's nine sites sit in helpers that are themselves called
    // from inside somebody else's transaction: `applyLifecycleTransitions`,
    // `calculateModificationSettlementOptions` and
    // `calculateModificationChangeFee`. None of them contains a transaction
    // opener, so Part A reports all three as safe.
    //
    // Derived from the source, not from a list of helpers: a function that
    // RECEIVES a Prisma client is a function whose caller decided which client
    // to use, so reaching past it for the module client discards that decision.
    for (const site of CALL_SITES) {
      if (site.insideTransaction) continue; // Part A already covers those.
      if (!site.enclosing || !declaresClientParameter(site.enclosing.params)) {
        continue;
      }
      const client = clientArgument(site);
      const where =
        `${site.file}:${site.line} ${site.reader}(...) inside ` +
        `${site.enclosing.name}(), which receives a Prisma client`;
      expect(
        client,
        `${where} but does not pass it on. ${RULE}`,
      ).not.toBeNull();
      expect(
        client,
        `${where} but reaches for the module client instead. ${RULE}`,
      ).toMatch(/^(?:tx|db)\b/);
    }
  });

  it("leaves the readers themselves with no module-client read", () => {
    // The source-side half. Every read in `cancellation.ts` must go through the
    // `db` parameter, or the parameter is decoration and passing `tx` changes
    // nothing — a shape this repository has shipped before (a guard satisfied by
    // an unrelated block elsewhere in the same file).
    const code = stripComments(readRepoFile("src/lib/cancellation.ts"));
    const moduleReads = [
      ...code.matchAll(/\bprisma\.(\w+)\.(findMany|findUnique|findFirst)\b/g),
    ].map((m) => m[0]);
    expect(
      moduleReads,
      `src/lib/cancellation.ts reads the policy set on the module client. ` +
        `Every read must go through the db parameter. ${RULE}`,
    ).toEqual([]);
    for (const reader of READERS) {
      expect(
        code,
        `${reader} no longer declares the db parameter, so an ` +
          `in-transaction caller cannot pass tx. ${RULE}`,
      ).toContain(`db: CancellationPolicyDb = prisma`);
    }
  });

  it("keeps db REQUIRED in the two transaction-scoped helper modules", () => {
    // These two modules import no module-level Prisma client at all, and their
    // `db` is required for that reason: a `db = prisma` default would put a
    // silent fall-back to a second pooled connection inside a
    // transaction-scoped helper — the exact failure this issue removes, in the
    // hardest place to see it. It also makes the caller census a typecheck
    // rather than a grep.
    for (const file of [
      "src/lib/booking-modify-settlement.ts",
      "src/lib/booking-modify-plan.ts",
    ]) {
      const code = stripComments(readRepoFile(file));
      expect(
        code,
        `${file} declares db as optional or defaulted. Keep it required: this ` +
          `module is transaction-scoped and a default hides the second ` +
          `connection. ${RULE}`,
      ).not.toMatch(/\bdb\s*(?:\?\s*:|=\s*prisma)/);
      expect(
        code,
        `${file} now imports the module-level Prisma client. A ` +
          `transaction-scoped helper must take its client from its caller. ` +
          `${RULE}`,
      ).not.toMatch(/import\s*\{[^}]*\bprisma\b[^}]*\}\s*from\s*"@\/lib\/prisma"/);
    }
  });
});
