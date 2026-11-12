import { execFileSync } from "node:child_process";

import { escapeRegex } from "./escape-regex.mjs";
import {
  fetchLivePrBody,
  gitDiffChangedFiles,
  parseNameStatus,
  readEventPrBody,
  sectionAfterHeading,
  selectPrBody,
} from "./pr-body.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const HEADING = "## Concurrency And Lock Impact";

const GATE_LABEL = "PR concurrency declaration check";

export const REQUIRED_FIELDS = [
  "Writer class(es), canonical lock key(s), and acquisition order",
  "Immutable pre-lock key source and mutable under-lock re-read",
  "Status-guarded claim and proof that a lost claim runs no side effect",
  "Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence",
  "Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`)",
];

const SENSITIVE_PATH = /^(?:src\/(?:app\/api|lib)\/.*(?:booking|capacity|payment|refund|credit|settlement|waitlist|webhook|cron|xero|stripe|membership|member-lifecycle)|prisma\/schema\.prisma|prisma\/migrations\/)/i;

// Pure test/spec files never move money, capacity, or lifecycle state, so they
// must not force a full concurrency declaration. Filter them out before the
// sensitive-path check: a test-only PR may legitimately check N/A, while a PR
// that also touches real sensitive source still needs the full declaration.
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Whether a changed path is a CANDIDATE for a full declaration: sensitive by
 * name, and not a pure test file. This is the gate's answer when it has no
 * content to look at, and the first filter when it has (#5038). Exported so that
 * anything writing a declaration on a pull request's behalf
 * (`render-epic-sync-pr-body.mjs`, #3721) asks this gate's own question instead
 * of keeping a second copy of the pattern; that caller has no file content, so
 * it gets the fail-closed, name-only answer.
 */
export function isConcurrencySensitivePath(file) {
  return !TEST_FILE.test(file) && SENSITIVE_PATH.test(file);
}

// The schema and its migrations are sensitive whatever they contain: a column,
// index or constraint change is itself what two writers race over.
const ALWAYS_SENSITIVE_PATH = /^prisma\//i;

/**
 * What makes a file able to take part in a race (#5038). A name-matched file is
 * exempt from the declaration ONLY when its whole text holds none of these.
 *
 * Every pattern runs over the raw text, comments and strings included, and each
 * is deliberately wider than the thing it names. A false "sensitive" costs an
 * author five lines; a false "safe" hides a race. Do not narrow one of these
 * without a measured list of the files that newly become exempt.
 *
 * The first four are what the issue names: a transaction, a database write, raw
 * SQL, a lock. The last three close the routes by which a file with none of
 * those words still reaches a writer:
 *
 *  - `asynchronous code`: a route or service that only AWAITS a writer in
 *    another module (`src/app/api/webhooks/stripe/route.ts`,
 *    `src/app/api/bookings/[id]/cancel/route.ts`) holds no write of its own, and
 *    text alone cannot show what its callee does. Only a synchronous module is
 *    provably unable to write, lock or call a provider itself.
 *  - `database client`: a synchronous file that names `prisma` can hand the
 *    client, or a pending query, to something that does.
 *  - `re-export`: a barrel exposes whatever the module behind it holds.
 */
const CONCURRENCY_CONSTRUCTS = [
  {
    name: "transaction",
    pattern: /\$transaction|TransactionClient|\btransaction\s*\(|\b(?:tx|\w+Tx)\b/,
  },
  {
    name: "database write",
    pattern:
      /\.(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(|\[\s*["'`](?:create|update|upsert|delete)\w*["'`]\s*\]/,
  },
  {
    // A provider or network call reached through a client handed in as a
    // parameter (`s.paymentIntents.cancel(id)`): no import shows the writer, so
    // the call shape itself must. Wide on purpose.
    name: "provider call",
    pattern:
      /\bfetch\s*\(|\.(?:paymentIntents|refunds|charges|checkout|customers|accountingApi|invoices|payments|creditNotes|contacts)\b|\.(?:capture|cancel|refund|confirm|send)\w*\s*\(/,
  },
  {
    name: "raw SQL",
    pattern:
      /(?:execute|query)Raw|\bPrisma\s*\.\s*(?:sql|raw|join|empty)\b|\bsql\s*`|\b(?:SELECT|INSERT|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE)\b/,
  },
  {
    name: "lock",
    pattern:
      /advisory|\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b|\bSKIP\s+LOCKED\b|\bNOWAIT\b|\bLOCK\s+TABLE\b/i,
  },
  {
    // Case-sensitive on purpose: `lockMemberCreditLedger(`, `acquireLodgeCapacityLock(`
    // and `…WithLodgeLockHeld(` are lock helpers; `multilineBlock(` and `clock(` are not.
    name: "lock helper",
    pattern: /\b(?:lock|\w+Lock)\w*\s*\(/,
  },
  {
    name: "asynchronous code",
    pattern: /\basync\b|\bawait\b|\bPromise\b|\.then\s*\(/,
  },
  {
    name: "database client",
    pattern: /(?<![@\w.-])prisma\b(?!\/client)|\bPrismaClient\b/,
  },
  {
    name: "re-export",
    pattern: /^[^\S\r\n]*export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\b/m,
  },
];

/** The constructs a file's text holds, by name. Empty means none were found. */
export function concurrencyConstructsIn(content) {
  return CONCURRENCY_CONSTRUCTS.filter(({ pattern }) => pattern.test(content)).map(
    ({ name }) => name,
  );
}

/**
 * THE definition of "this changed file obliges a full declaration". The CI gate
 * and `pnpm run pr:check` both reach it through `validateConcurrencyDeclaration`,
 * so they cannot disagree (`INV-SSOT`).
 *
 * `contentsOf(file)` returns the file's text on EVERY side of the diff that has
 * it — the pull request's head, and the merge base when the file existed there —
 * or throws when it cannot. Both sides are read because a change that REMOVES a
 * lock or a transaction leaves a head with none, and that is the change the
 * declaration most needs to see.
 *
 * It is the whole file, never the changed lines: a logic change inside a
 * transaction may touch no line that names the transaction.
 *
 * Fails closed. A name-matched file is sensitive unless content was read and is
 * clean, so each of these stays sensitive: no reader at all, a reader that
 * throws (a deleted or renamed-away file has no head content, an unreadable one
 * no content), a reader that returns nothing or something that is not text, and
 * any error in the check itself.
 */
export function isConcurrencySensitiveChange(file, contentsOf = null) {
  if (!isConcurrencySensitivePath(file)) return false;
  if (ALWAYS_SENSITIVE_PATH.test(file)) return true;
  if (typeof contentsOf !== "function") return true;
  try {
    const contents = contentsOf(file);
    if (!Array.isArray(contents) || contents.length === 0) return true;
    if (
      contents.some(
        (content) => typeof content !== "string" || concurrencyConstructsIn(content).length > 0,
      )
    ) {
      return true;
    }
    return !importGraphIsClean(file, contents, contentsOf.atHead);
  } catch {
    return true;
  }
}

// Runtime (non-`type`) imports, re-exports and dynamic imports, by specifier.
const RUNTIME_IMPORT =
  // Not anchored to a line start and not stopped by `;`: a comment before
  // `import`, or a `;` inside the braces, must not hide an import. Over-matching
  // (an import-shaped comment) only resolves to a file or fails closed.
  /\b(?:import|export)\s+(?!type\s+(?!from\b))[\s\S]{0,4000}?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["'`]([^"'`]+)|\brequire\s*\(\s*["'`]([^"'`]+)/g;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"];

/** Local runtime import specifiers in `content` (`@/…` and relative); packages are skipped. */
export function localRuntimeImports(content) {
  return [...content.matchAll(RUNTIME_IMPORT)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? match[4])
    .filter((spec) => spec.startsWith("@/") || spec.startsWith("."));
}

function candidatePaths(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) {
    base = `src/${spec.slice(2)}`;
  } else {
    const parts = fromFile.split("/").slice(0, -1);
    for (const part of spec.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== "." && part !== "") parts.push(part);
    }
    base = parts.join("/");
  }
  return RESOLVE_SUFFIXES.map((suffix) => base + suffix);
}

/**
 * #5038 follow-through: a synchronous file can still REACH a writer by forwarding
 * to one (`return settleBooking(id)`, `void settleBooking(id)`) without any of
 * the constructs above in its own text. The only way it can name that writer is
 * an import, so a name-matched file is exempt only when every local module it
 * imports at runtime, followed through the whole graph at the PR's head, is
 * itself free of every construct. Packages (`zod`, `react`, `@prisma/client`
 * enums) are not followed: `PrismaClient` and `prisma` are caught as constructs.
 *
 * Fails closed: an import that cannot be resolved, a reader without `atHead`
 * while local imports exist, or any read error leaves the file sensitive.
 */
function importGraphIsClean(file, contents, atHead) {
  const pending = contents.flatMap((content) =>
    localRuntimeImports(content).map((spec) => ({ from: file, spec })),
  );
  if (pending.length === 0) return true;
  if (typeof atHead !== "function") return false;
  const seen = new Set([file]);
  while (pending.length > 0) {
    const { from, spec } = pending.pop();
    let resolved = null;
    let text = null;
    for (const candidate of candidatePaths(from, spec)) {
      const found = atHead(candidate);
      if (typeof found === "string") {
        resolved = candidate;
        text = found;
        break;
      }
    }
    if (resolved === null) return false;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (concurrencyConstructsIn(text).length > 0) return false;
    for (const next of localRuntimeImports(text)) pending.push({ from: resolved, spec: next });
  }
  return true;
}

/**
 * A `contentsOf` reader over git objects for the range `base...head`, the same
 * range `gitDiffChangedFiles` lists. Reading objects rather than the working
 * tree is deliberate: on a `pull_request` event the checkout is GitHub's merge
 * commit, not the head, and the offline runner's working tree can hold edits its
 * diff does not.
 *
 * Head content is required, so a path the head no longer has (deleted, or the
 * old name of a rename) throws and is read as sensitive. Base content is read
 * when the merge base has the path; an added file has only its head.
 */
export function gitContentsReader({ base, head, cwd } = {}) {
  const git = (args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
  let mergeBase = null;
  let headFiles = null;
  const reader = (file) => {
    const headContent = git(["show", `${head}:${file}`]);
    mergeBase ??= git(["merge-base", base, head]).trim();
    // `--literal-pathspecs`: route paths hold glob characters (`[id]`).
    const atBase = git(["--literal-pathspecs", "ls-tree", "--name-only", mergeBase, "--", file]);
    return atBase.trim() === "" ? [headContent] : [headContent, git(["show", `${mergeBase}:${file}`])];
  };
  // A path's text at the head, or `null` when the head has no such file. Used to
  // follow a file's imports (`importGraphIsClean`); a read error still throws.
  reader.atHead = (file) => {
    headFiles ??= new Set(git(["ls-tree", "-r", "--name-only", head]).split("\n"));
    return headFiles.has(file) ? git(["show", `${head}:${file}`]) : null;
  };
  return reader;
}

const EXEMPTION_HINT =
  " A file on a sensitive path is exempt only when it is synchronous and holds no " +
  "transaction, database write, raw SQL, lock or lock helper call, database client " +
  "or re-export, at " +
  "the pull request's head and at its merge base, and every local module it imports " +
  "is the same at the head.";

// Match a required field bullet whose value sits on the SAME line as its label.
// Horizontal-whitespace classes (`[^\S\r\n]`) keep `\s` from swallowing the
// newline(s) after an empty bullet and capturing the next bullet as the value;
// the trailing `\r?` tolerates GitHub's CRLF-stored PR bodies. A value of only
// whitespace fails because the capture must start with `\S`.
function fieldValuePattern(field) {
  return new RegExp(
    `^[^\\S\\r\\n]*-[^\\S\\r\\n]*${escapeRegex(field)}:[^\\S\\r\\n]*(\\S[^\\r\\n]*?)[^\\S\\r\\n]*\\r?$`,
    "m",
  );
}

/**
 * Validate a PR body's concurrency declaration against the PR's diff.
 *
 * `changedFiles` carries the diff and has THREE meaningful states, not two:
 *   - a non-empty array — the changed paths;
 *   - an empty array — the diff is known and touches nothing;
 *   - `null` (or omitted) — the diff is UNKNOWN, because the caller had no
 *     `PR_BASE_SHA`/`PR_HEAD_SHA` or could not resolve a local merge base.
 *
 * Unknown is NOT the same as empty, and conflating the two is what would turn
 * the #2726 short-circuit below into a hole: an unknown diff would look
 * non-sensitive and waive the section for every PR. Unknown is therefore
 * treated as possibly sensitive, on BOTH paths that consult the diff — the
 * section stays required, and a ticked `N/A` is refused rather than taken on
 * trust, because "I could not look" is not evidence that nothing sensitive
 * changed. Only a complete declaration passes on an unknown diff.
 *
 * `contentsOf` is the reader `isConcurrencySensitiveChange` narrows with
 * (#5038). Omitted, there is no content evidence and every name-matched file is
 * sensitive, which is the gate's behaviour before the narrowing.
 */
export function validateConcurrencyDeclaration(body, changedFiles = null, { contentsOf = null } = {}) {
  const diffKnown = Array.isArray(changedFiles);
  const sensitiveFiles = (diffKnown ? changedFiles : []).filter((file) =>
    isConcurrencySensitiveChange(file, contentsOf),
  );

  // Anchor to the START OF A LINE (`sectionAfterHeading`). A plain indexOf also
  // matches the heading text quoted inside prose or a code span — and a PR body
  // that explains this gate will quote it. When that mention comes first, the
  // "section" starts there and runs to the next `## `, so the real declaration
  // below is never read and every field reports missing. Found exactly that
  // way: this gate's own PR body.
  const section = sectionAfterHeading(body, HEADING);
  if (section === null) {
    // #2726: when the diff is KNOWN and holds no sensitive file (#5038 narrowed
    // that from "non-test file on a sensitive path" to one that can also write,
    // lock or reach a writer), a missing section is not a failure — the same short-circuit the
    // changelog gate has had since #2452 (`isCodeBearing`), keyed on the very
    // condition this gate already uses to decide whether `N/A` is acceptable.
    //
    // This loses no enforcement, and the proof is exact rather than approximate:
    // the set of PRs newly allowed to omit the section is the SAME set that the
    // `N/A` branch below already accepts (`sensitiveFiles.length === 0`), so
    // every PR this waives is one the gate would have passed anyway the moment
    // the author pasted a heading and ticked a box. Nothing that must produce a
    // real declaration — booking, capacity, payment, refund, credit,
    // settlement, waitlist, webhook, cron, Xero, Stripe, membership, lifecycle,
    // `prisma/schema.prisma`, `prisma/migrations/` — changes by one byte.
    //
    // Every Dependabot PR failed here permanently before this: Dependabot writes
    // its own body and cannot use `.github/pull_request_template.md`. The fix
    // deliberately keys off the DIFF, never off the author — an actor exemption
    // would wave through a bot PR bumping `@prisma/client` or `stripe` while
    // still failing a human's docs-only PR.
    if (diffKnown && sensitiveFiles.length === 0) {
      return { outcome: "no-sensitive-paths" };
    }
    throw new Error(
      `PR body must include ${HEADING}.` +
        (sensitiveFiles.length > 0
          ? ` It is required because this PR changes concurrency-sensitive files: ${sensitiveFiles.join(", ")}.${EXEMPTION_HINT}`
          : ""),
    );
  }

  if (/^\s*-\s*\[[xX]\]\s*N\/A\b/m.test(section)) {
    // Same three-state reading as the waiver above. `N/A` is a claim ABOUT the
    // diff, so it can only be accepted against a diff that was actually read;
    // with an unknown diff `sensitiveFiles` is empty for want of evidence, not
    // because nothing sensitive changed, and accepting it here would leave the
    // gate's most consequential answer resting on a list nobody produced.
    if (!diffKnown) {
      throw new Error(
        "Concurrency declaration cannot use N/A here: the PR diff could not be resolved, " +
          "so there is no evidence that no sensitive path changed. Make the diff readable " +
          "(fetch the base branch, or pass --base <ref> to pnpm run pr:check), or complete " +
          "the declaration fields instead.",
      );
    }
    if (sensitiveFiles.length > 0) {
      throw new Error(
        `Concurrency declaration cannot use N/A for sensitive paths: ${sensitiveFiles.join(", ")}.${EXEMPTION_HINT}`,
      );
    }
    return { outcome: "declared-n-a" };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fieldValuePattern(field).test(section)) {
      // Say WHY, not just WHICH. The overwhelmingly common cause is a value
      // wrapped onto the line below its label, which reads as an empty field —
      // and an author who is told only "complete this field" while looking at a
      // field they believe they completed will re-guess the format, burning a
      // full CI cycle per attempt. Naming the same-line rule here is what makes
      // this failure self-correcting on the first try.
      const labelPresent = new RegExp(
        `^[^\\S\\r\\n]*-[^\\S\\r\\n]*${escapeRegex(field)}:`,
        "m",
      ).test(section);
      throw new Error(
        labelPresent
          ? `Concurrency declaration field "${field}:" has no value on its own line. ` +
            "Put the value on the SAME line as the label — a value wrapped onto the " +
            "following line reads as empty. Continuation lines after that first " +
            "line are fine. Check it before pushing with: pnpm run pr:check <body-file>"
          : `Concurrency declaration must complete "${field}:" or explicitly check N/A. ` +
            "Copy the field list verbatim from .github/pull_request_template.md — the " +
            "labels are matched exactly. Check it before pushing with: " +
            "pnpm run pr:check <body-file>",
      );
    }
  }

  const compatibilityEvidence = section.match(fieldValuePattern(REQUIRED_FIELDS[3]))?.[1] ?? "";
  if (!/#\d+/.test(compatibilityEvidence)) {
    throw new Error(
      "Concurrency compatibility evidence must identify at least one reviewed open or last-10 PR number.",
    );
  }

  return { outcome: "complete" };
}

// Why a passing run passed. Mirrors `OUTCOME_MESSAGES` in the changelog gate:
// a log line reading only "complete" on a PR that never carried a section is
// how a waiver quietly becomes indistinguishable from a real declaration.
const OUTCOME_MESSAGES = {
  "no-sensitive-paths":
    "no non-test file on a concurrency-sensitive path changed that can write, lock or reach a writer, so no declaration is required.",
  "declared-n-a": "the PR body declares N/A and no concurrency-sensitive file changed.",
  complete: "the PR body carries a complete declaration.",
};

if (isMainModule(import.meta.url)) {
  try {
    const base = process.env.PR_BASE_SHA;
    const head = process.env.PR_HEAD_SHA;
    // `null`, not `[]`, when the range is missing: without it the diff is
    // UNKNOWN, and an unknown diff must not be read as "changed nothing" — that
    // is the one classification that waives the section (#2726). Fail closed and
    // keep asking for the declaration instead.
    //
    // The diff goes through `parseNameStatus`, exactly as the changelog gate and
    // the offline `pnpm run pr:check` runner do, so a RENAME arrives as its
    // delete + add pair. A bare `--name-only` listing prints only the rename's
    // destination, which let a PR move `src/lib/payment-settlement.ts` to
    // `src/lib/ledger.ts`, edit it, and match no sensitive path at all — and
    // made CI and the offline runner reach opposite verdicts on one diff.
    const changedFiles =
      base && head
        ? [
            ...new Set(
              parseNameStatus(gitDiffChangedFiles(base, head)).map((change) => change.path),
            ),
          ]
        : null;
    const fetchedBody = await fetchLivePrBody(GATE_LABEL);
    const body = selectPrBody({ fetchedBody, eventBody: readEventPrBody() });
    // Content is read from git objects over the same range as the diff. With no
    // range there is no diff either, and the validator never consults a reader.
    const contentsOf = base && head ? gitContentsReader({ base, head }) : null;
    const { outcome } = validateConcurrencyDeclaration(body, changedFiles, { contentsOf });
    console.log(`PR concurrency declaration check passed: ${OUTCOME_MESSAGES[outcome]}`);
  } catch (error) {
    console.error(`${GATE_LABEL} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
