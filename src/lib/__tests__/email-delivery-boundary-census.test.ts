import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  composeFiles,
  composeServices,
  readRepoFile,
} from "@/lib/__tests__/helpers/compose";

/**
 * INV-CONFIG-004: every application-controlled send goes through ONE
 * environment-aware boundary (ENV-SAFETY 2, #3035; epic #2986).
 *
 * WHAT THIS ADDS THAT THE TYPE SYSTEM DOES NOT. The primary guarantee is a type:
 * `getEmailTransporter` and `sendXeroInvoiceEmail` require a `DeliveryClearance`,
 * which only `environment-delivery-policy.ts` can mint and only when the
 * environment role resolved PRODUCTION, so a new sender cannot obtain a transport
 * without asking the policy. That is stronger than any census, because it is not
 * a list of the senders that exist today.
 *
 * It has exactly three holes, and this file closes all three:
 *
 * 1. **A new `nodemailer.createTransport` call.** Nothing stops a future module
 *    building its own transport from scratch, which is precisely what
 *    `cron-email-retry.ts` did before this issue — and why "one common boundary"
 *    was not the state of the tree.
 * 2. **A new `accountingApi.emailInvoice` call.** Asking Xero to email a member
 *    reaches no transport at all, so no clearance type stands in its way.
 * 3. **A cast.** `{} as unknown as DeliveryClearance` type-checks. The policy
 *    module refuses a forged token at runtime, so the cast fails closed rather
 *    than working — but it fails closed by throwing in production, and a source
 *    census catches it in review instead.
 *
 * `test:related` CANNOT select this file: it reads `src/` from disk with `fs`, so
 * it has no import edge to the files it scans. Run it explicitly, and expect CI
 * to be the backstop (`docs/TESTING.md`).
 */

/**
 * The roots scanned, widened past `src/` (#3035 review) and then past those
 * four (#3071 review, hoppers99).
 *
 * `scripts/`, `prisma/` and `e2e/` were outside the scan, so a mail transport
 * built in a maintenance script or a seed would have been invisible to every case
 * in this file. Measured free to add: none of those roots names `createTransport`,
 * `sendMail` or `emailInvoice` today.
 *
 * `measurement/` was the remaining gap, and it is a real one rather than a
 * theoretical one: that tree stands up its own application stack with its own
 * mail configuration (`measurement/stack/docker-compose.measure.yml` sets
 * `EMAIL_SERVER_HOST: mailpit`) and it holds executable `.mjs` under
 * `measurement/phase2/bin/`, so a transport built there would have been invisible
 * to every case in this file. It was hand-verified clean when the gap was
 * reported, which this scan now keeps true rather than re-establishing by hand.
 *
 * Nothing beyond these five is scanned, which is the stated limit — a transport
 * built inside `node_modules` or generated code is not something this census can
 * see, and the clearance TYPE is what covers that case.
 */
const SCAN_ROOTS = ["src", "scripts", "prisma", "e2e", "measurement"]
  .map((dir) => path.resolve(process.cwd(), dir))
  .filter((dir) => existsSync(dir));
const SRC = path.resolve(process.cwd(), "src");
/**
 * `.mjs` and `.js` as well, because `scripts/` is 31 ESM modules and no
 * TypeScript at all — scanning that root while collecting only `.ts` would have
 * been a widening that added nothing. Measured free: none of them names
 * `createTransport`, `sendMail` or `emailInvoice`. No compiled output lives under
 * the scanned roots (`src/`, `prisma/` and `e2e/` hold zero `.js`).
 */
const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);

const TRANSPORT_MODULE = "src/lib/email/internal.ts";
const POLICY_MODULE = "src/lib/environment-delivery-policy.ts";
const XERO_EMAIL_MODULE = "src/lib/xero-invoice-email.ts";

/**
 * The two modules that may hold a live delivery transport, and why each one is
 * allowed to rather than merely observed to.
 *
 * `email/core.ts` is `sendEmail`, the funnel every application message goes
 * through. `cron-email-retry.ts` is the replay job, which cannot go through
 * `sendEmail` because it re-transmits a body rendered by an earlier process
 * rather than rendering a new one. Anything else asking for a transport is a
 * third boundary, which is the thing this issue exists to prevent.
 */
const TRANSPORT_CONSUMERS = [
  "src/lib/cron-email-retry.ts",
  "src/lib/email/core.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__") continue;
      walk(full, out);
    } else if (
      EXTENSIONS.has(path.extname(name)) &&
      !/\.test\.tsx?$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/** Every production file under the scanned roots whose text matches, sorted. */
function filesMatching(pattern: RegExp): string[] {
  return SCAN_ROOTS.flatMap((root) => walk(root))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map(repoRelative)
    .sort();
}

/**
 * TypeScript comments removed, so a census may match a BARE identifier without
 * being tripped by prose that merely mentions it.
 *
 * This is what lets the transport patterns widen from `createTransport\s*\(` to
 * the bare name (#3035 review). The narrow forms were evadable by an ordinary
 * tidy-up — `const ct = nodemailer.createTransport; ct(...)`, or
 * `nodemailer["createTransport"](...)` — and matching the identifier itself
 * closes both. Without stripping comments the same widening would fail the day
 * somebody wrote "we do not call createTransport here" in a docblock, which is a
 * false positive that teaches its reader to ignore the census.
 */
function withoutTypeScriptComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** {@link filesMatching}, over code with comments stripped. */
function codeFilesMatching(pattern: RegExp): string[] {
  return SCAN_ROOTS.flatMap((root) => walk(root))
    .filter((file) =>
      pattern.test(withoutTypeScriptComments(readFileSync(file, "utf8"))),
    )
    .map(repoRelative)
    .sort();
}

// ---------------------------------------------------------------------------
// Configuration BLOCKS, for the capture-declaration case below.
// ---------------------------------------------------------------------------

/** One place a transport can be configured, with an id a reader can act on. */
type ConfigBlock = { id: string; text: string };

/**
 * Comments stripped the way this repository's own dotenv reader strips them:
 * a whole-line `#`, and an inline `#` preceded by whitespace.
 *
 * Needed because `.env.example` and `.env.staging.example` both EXPLAIN the
 * mutually-exclusive rule in prose containing `USE_LOCAL_CAPTURE=true`, and a
 * guard satisfied by its own documentation is a guard that has stopped working.
 */
function withoutComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

/** `NAME: "true"` / `NAME='TRUE'` / `NAME=true`, quoting and case normalised. */
function flagIsTrue(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*[:=]\\s*["']?\\s*true\\s*["']?`, "i").test(text);
}

/** A relay host this repository's own configuration files use as a capture. */
const CAPTURE_HOST = /\bEMAIL_SERVER_HOST\s*[:=]\s*["']?(mailpit|mailhog)\b/i;

/**
 * Every discovered block in which a transport could be configured: each tracked
 * dotenv file, each workflow env heredoc, and — per Compose file — the shared
 * anchor plus every individual service.
 *
 * DISCOVERED, NOT LISTED. A hardcoded four-element array of stacks left a fifth
 * unguarded, and iterating whole FILES let one correct block excuse a sibling.
 */
function captureCandidateBlocks(): ConfigBlock[] {
  const root = process.cwd();
  const blocks: ConfigBlock[] = [];

  for (const name of readdirSync(root).sort()) {
    if (!/^\.env($|\.)/.test(name)) continue;
    blocks.push({ id: name, text: withoutComments(readRepoFile(name)) });
  }

  const workflows = path.join(root, ".github", "workflows");
  for (const name of readdirSync(workflows).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(path.join(workflows, name), "utf8");
    const opener = /cat > ([^\s]+) <<'?EOF'?/g;
    let match: RegExpExecArray | null;
    let index = 0;
    while ((match = opener.exec(text)) !== null) {
      index += 1;
      const rest = text.slice(match.index + match[0].length);
      const end = rest.indexOf("\nEOF");
      blocks.push({
        id: `.github/workflows/${name} -> ${match[1]} #${index}`,
        text: withoutComments(end === -1 ? rest : rest.slice(0, end)),
      });
    }
  }

  for (const file of composeFiles) {
    const text = readRepoFile(file);
    const anchor = text.indexOf("x-app-environment:");
    if (anchor > -1) {
      const rest = text.slice(anchor);
      const end = rest.search(/\n[^\s#]/);
      blocks.push({
        id: `${file} -> x-app-environment`,
        text: withoutComments(end === -1 ? rest : rest.slice(0, end)),
      });
    }
    for (const [service, body] of composeServices(file)) {
      blocks.push({ id: `${file} -> ${service}`, text: withoutComments(body) });
    }
  }

  return blocks;
}

describe("email delivery boundary census (INV-CONFIG-004)", () => {
  it("creates a mail transport in exactly one module", () => {
    expect(
      // The bare identifier, over comment-stripped code: `createTransport\s*\(`
      // was defeated by `const ct = nodemailer.createTransport; ct(...)` and by
      // `nodemailer["createTransport"](...)`, both ordinary tidy-ups.
      codeFilesMatching(/\bcreateTransport\b/),
      "A mail transport may only be created in " +
        `${TRANSPORT_MODULE}, which requires a DeliveryClearance for the ` +
        "sending accessor and offers verifyEmailTransport() for a diagnostic " +
        "that must not be able to send. A transport built anywhere else is a " +
        "second delivery boundary that the environment-safety policy cannot " +
        "see — exactly what cron-email-retry.ts was before #3035. Call " +
        "getEmailTransporter(clearance) or verifyEmailTransport() instead " +
        "(INV-CONFIG-004).",
    ).toEqual([TRANSPORT_MODULE]);
  });

  it("hands a sending transport to exactly the two modules that funnel sends", () => {
    const consumers = filesMatching(/getEmailTransporter\s*\(/).filter(
      (file) => file !== TRANSPORT_MODULE,
    );
    expect(
      consumers,
      "Only the mailer and the retry cron may hold a sending transport. A new " +
        "caller means a new send path: put the message through sendEmail() so " +
        "it gets the EmailLog row, the placeholder/booking/suppression gates " +
        "and the environment-safety gate, rather than reaching for a transport " +
        "of its own (INV-CONFIG-004).",
    ).toEqual(TRANSPORT_CONSUMERS);
  });

  it("calls transporter.sendMail in exactly those two modules", () => {
    expect(
      // Bare identifier, same reasoning as `createTransport` above: handing a
      // message to a provider is the act that matters, and an aliased receiver
      // still has to name the method.
      codeFilesMatching(/\bsendMail\b/),
      "A message may only be handed to a provider from the mailer or the retry " +
        "cron (INV-CONFIG-004).",
    ).toEqual(TRANSPORT_CONSUMERS);
  });

  it("asks Xero to email an invoice in exactly one module", () => {
    /*
      `\.emailInvoice\s*\(` rather than `accountingApi\.emailInvoice\s*\(`. The
      narrower form was defeated by three ORDINARY tidy-ups, all measured:
      `const api = xero.accountingApi; api.emailInvoice(...)`,
      `const { emailInvoice } = xero.accountingApi`, and
      `xero.accountingApi["emailInvoice"](...)`. Aliasing a long provider
      accessor is exactly the kind of edit nobody thinks twice about. Widening is
      free: all twenty `accountingApi` accesses under `src/` use the literal
      `xero.accountingApi` receiver today, so the wider pattern still resolves to
      exactly this wrapper.
    */
    expect(
      filesMatching(/\.emailInvoice\s*\(/),
      "Asking Xero to email an invoice is a send to a real member's real " +
        `address, and it must go through ${XERO_EMAIL_MODULE}, which requires ` +
        "a DeliveryClearance. Three workflows raise invoices (booking, group " +
        "settlement, membership subscription) and all three call the wrapper; " +
        "a fourth call site here would be an ungated provider send " +
        "(INV-CONFIG-004).",
    ).toEqual([XERO_EMAIL_MODULE]);
  });

  /**
   * Every BLOCK that points the app at a capture container must DECLARE it a
   * capture.
   *
   * This guard exists because the defect it catches is invisible until the
   * browser suite runs. Since #3035 a non-production installation suppresses
   * every send unless its transport is declared to be a capture mailbox, so a
   * stack relaying to mailpit as an ordinary `USE_SMTP_RELAY` captures NOTHING —
   * and `e2e/two-factor-email.spec.ts` reads a real two-factor code back over
   * mailpit's HTTP API, so it and every other mail-reading spec fail with an
   * empty mailbox rather than with anything that names the cause.
   *
   * It is deliberately keyed on `EMAIL_SERVER_HOST=mailpit` — the only place in
   * this repository where a host name is allowed to imply anything, because this
   * is a test over the repository's own tracked configuration files and not a
   * runtime inference. The application itself never infers capture mode from a
   * host name; see `email-delivery.ts`.
   *
   * THREE THINGS A PROBE BROKE IN THE FIRST VERSION, all fixed here:
   *
   * 1. It tested WHOLE-FILE text, so one correct declaring block satisfied a
   *    file holding several. Reproduced on a synthetic two-heredoc file: it
   *    PASSED. Both `e2e.yml` heredocs happen to be right today, but either one
   *    being right satisfied the file.
   * 2. It iterated a hardcoded four-element list of stacks, so a fifth stack was
   *    unguarded. The blocks are now DISCOVERED.
   * 3. It matched only double quotes and only lower case, so
   *    `USE_SMTP_RELAY: 'true'` evaded the mutual-exclusion check — the UNSAFE
   *    direction — while `USE_LOCAL_CAPTURE: 'true'` was a false positive.
   *    `parseBooleanFlag` is case-insensitive, so the guard and the application
   *    now normalise the same way.
   *
   * The RENDERED plumbing — whether a container is given the variable at all —
   * is a different question and is asserted in `env-delivery-census.test.ts`.
   * This one is about what the tracked files SAY.
   */
  it("declares USE_LOCAL_CAPTURE in every block that relays to a capture container", () => {
    const blocks = captureCandidateBlocks();

    // Anti-vacuity: discovery must actually find the blocks that exist today,
    // or this case judges nothing while passing. Named rather than counted, so a
    // block disappearing is a failure rather than a smaller number.
    const declaring = blocks
      .filter((block) => CAPTURE_HOST.test(block.text))
      .map((block) => block.id)
      .sort();
    expect(blocks.length, "no configuration blocks were discovered").toBeGreaterThan(6);
    expect(declaring).toEqual([
      ".env.staging.example",
      ".github/workflows/e2e.yml -> .env.staging #1",
      ".github/workflows/e2e.yml -> .env.staging #2",
      "measurement/stack/docker-compose.measure.yml -> app",
    ]);

    const offenders: string[] = [];
    for (const block of blocks) {
      if (!CAPTURE_HOST.test(block.text)) continue;
      if (!flagIsTrue(block.text, "USE_LOCAL_CAPTURE")) {
        offenders.push(`${block.id}: relays to a capture container without USE_LOCAL_CAPTURE=true`);
      }
      if (flagIsTrue(block.text, "USE_SMTP_RELAY")) {
        offenders.push(
          `${block.id}: sets USE_SMTP_RELAY=true, which is a LIVE provider mode and is mutually exclusive with the capture mode`,
        );
      }
      if (flagIsTrue(block.text, "USE_AWS_SES")) {
        offenders.push(
          `${block.id}: sets USE_AWS_SES=true, which is a LIVE provider mode and is mutually exclusive with the capture mode`,
        );
      }
    }
    expect(
      offenders,
      "A block pointed at a capture container must declare USE_LOCAL_CAPTURE=true " +
        "and no live provider flag. Without it a non-production installation " +
        "suppresses every send (#3035), the capture sees nothing, and every " +
        "browser spec that reads mail back — including the two-factor email code " +
        "— fails with an empty mailbox and no explanation (INV-CONFIG-004).",
    ).toEqual([]);
  });

  /**
   * Neither withheld-email renderer may blame one state for the other (#3035).
   *
   * Both render under TWO states — a confirmed copy, and an installation nobody
   * has declared — because both hold delivery back. "because it is treated as a
   * copy" is therefore false half the time, and false in the expensive direction:
   * the operator of an undeclared LIVE site goes looking for the safer override
   * instead of the missing declaration.
   *
   * A SOURCE census rather than a rendering test because
   * `environment-safety-panel.tsx` has no test harness at all, and inventing a
   * React suite to assert one sentence would be a worse trade than reading the
   * two functions. The readiness renderer's behaviour is separately exercised in
   * `setup-readiness.test.ts`, which drives the real check under both roles.
   */
  it("blames neither state for the other in the withheld-email renderers", () => {
    const RENDERERS = [
      "src/lib/setup-readiness.ts",
      "src/components/admin/environment-safety-panel.tsx",
    ];
    const offenders: string[] = [];
    for (const file of RENDERERS) {
      const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
      /*
        COMMENTS ARE STRIPPED FIRST, and the region is bounded by the NEXT
        top-level declaration rather than by the next `}` on its own line. Both
        halves were learned from a probe: the first version sliced to the next
        newline-brace, which in the panel lands on the end of that function's own
        multi-line RETURN TYPE — so the slice was the signature alone, held none of
        the sentences, and the guard was VACUOUSLY GREEN for that file. Restoring
        the panel's old wording did not fail it. Docblocks are excluded because
        they deliberately QUOTE the wrong sentence in order to explain why it is
        wrong.
      */
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      const start = stripped.indexOf("function describeWithheldEmail");
      expect(start, `${file} should still define describeWithheldEmail`).toBeGreaterThan(-1);
      const rest = stripped.slice(start + 1);
      /*
        THE END BOUND, WIDENED AND THEN TIGHTENED (#3035 review). It used to look
        only for `\n(?:export )?function `, which over-reached in
        `setup-readiness.ts` past the end of this function and swallowed the next
        top-level CONST — so the region judged wording that is not
        describeWithheldEmail's. It also could not see a `const` arrow or an
        `export default function` declaration at all, which is how a rewritten
        renderer would silently leave this guard reading the whole rest of the
        file.

        Now: the next thing at column 0 that starts ANY top-level declaration.
        The vacuity assertion below still requires the region to hold the wording
        being judged, so an over-tight bound fails loudly rather than passing on an
        empty slice.
      */
      const nextDeclaration = rest.search(
        /\n(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\s/,
      );
      const body = nextDeclaration === -1 ? rest : rest.slice(0, nextDeclaration);
      // The assertion that stops this guard going vacuous again: the extracted
      // region must actually contain the sentences being judged.
      expect(
        body,
        `${file}: the extracted describeWithheldEmail body holds no wording to check — this guard would be vacuous`,
      ).toMatch(/held back on this installation|steady and recent count/);
      if (/treated as a copy|because it is a copy/i.test(body)) {
        offenders.push(`${file}: attributes the withholding to being a copy`);
      }
      if (/declared a copy/i.test(body) !== /undeclared/i.test(body)) {
        offenders.push(
          `${file}: names one of the two reasons without the other`,
        );
      }
    }
    expect(
      offenders,
      "Both of these render under a confirmed copy AND an undeclared " +
        "installation. A sentence naming one reason is wrong half the time, and " +
        "on an undeclared LIVE site it sends the operator to the safer override " +
        "instead of the missing declaration. Name both reasons or neither; the " +
        "surrounding surface already says which state applies (INV-CONFIG-004).",
    ).toEqual([]);
  });

  /**
   * Every module that writes a "sent" TIMESTAMP around a send has to inspect the
   * outcome (#3035).
   *
   * THE CLASS, because the clearance token does not cover it. That token protects
   * the TRANSPORT; nothing protected the caller's bookkeeping. `sendEmail`
   * RETURNS `withheld_for_environment` without throwing, so three callers moved
   * business state as though the message had gone:
   *
   * - the pre-arrival cron stamped `preArrivalReminderSentAt` before the send and
   *   discarded the outcome. The stamp is the only thing the selecting query
   *   filters on, so it was consumed permanently — and that message carries the
   *   lodge's door code;
   * - the quote-expiry cron wrote `reminderSentAt` AND an audit row reading
   *   `outcome: "success"`, "Sent a pre-expiry reminder";
   * - the age-up cron had already flipped the tier and minted the invitation
   *   token, and its `catch`-block rollback never fired because a withhold does
   *   not throw.
   *
   * WHAT THIS CASE IS AND IS NOT. It is a SHAPE census: it finds every module
   * that both sends and stamps, and requires each to be acknowledged — either as
   * inspecting the outcome, or as writing a throttle rather than a one-shot
   * claim. The BEHAVIOUR is pinned where it belongs, in each caller's own suite
   * (`cron-pre-arrival-reminders.test.ts`, `cron-quote-expiry-reminders.test.ts`,
   * `cron-age-up.test.ts`, `cron-additional-payment-reminders.test.ts`), which
   * drive the real function with a withheld outcome and assert the state does not
   * move. What this adds is that a NEW stamp-writing sender cannot appear
   * silently: it fails here until somebody has decided which list it belongs in.
   *
   * A FULL census over every `outcome: "success"` audit row was considered and
   * rejected as disproportionate: fifty modules match, and in most of them the
   * audited action is the business action (a booking was force-confirmed), which
   * did succeed. Narrowing to a persisted "sent" timestamp is what isolates the
   * shape that loses a member's mail.
   */
  it("acknowledges every module that writes a sent-timestamp around a send", () => {
    /** Inspects the outcome before it advances state. */
    const INSPECTS_THE_OUTCOME = [
      "src/lib/additional-payment-resend-service.ts",
      "src/lib/cron-additional-payment-reminders.ts",
      "src/lib/cron-pre-arrival-reminders.ts",
      "src/lib/cron-quote-expiry-reminders.ts",
      // The mailer itself: it IS the thing that decides the outcome.
      "src/lib/email/core.ts",
      // The retry cron reads the policy directly and returns before it claims a
      // row, rather than reading a `sendEmail` outcome.
      "src/lib/cron-email-retry.ts",
      // Asks `resolveXeroInvoiceEmailPolicy` and returns BEFORE the `emailSentAt`
      // write when it answers withhold, so the stamp is never reached.
      "src/lib/xero-subscription-invoices.ts",
    ];

    /**
     * Writes a THROTTLE, not a one-shot claim, so a withheld send delays the next
     * attempt rather than consuming it.
     *
     * These are `lastSentAt`-style columns compared against an interval
     * (`now - lastSentAt < intervalDays`), so the row is selected again after the
     * interval and the message is not lost. Materially different from a
     * `preArrivalReminderSentAt: null` filter, which selects a row exactly once.
     * Left as they are deliberately: a change here would alter re-send cadence,
     * which is a product decision rather than a defect fix.
     */
    const RATE_LIMIT_STAMP_ONLY: Record<string, string> = {
      "src/lib/nomination.ts":
        "lastSentAt throttles a re-issue; the nomination stays selectable",
      "src/lib/placeholder-guest-name-reminders.ts":
        "attendeeConfirmationLastSentAt is compared against an interval, so the reminder recurs",
      "src/lib/school-attendee-confirmation.ts":
        "attendeeConfirmationLastSentAt is compared against an interval, so the reminder recurs",
      "src/app/api/admin/inductions/route.ts":
        "emailSentAt records the last operator-driven send; the operator can send again",
      "src/lib/token-email-recovery.ts":
        "lastSentAt records an operator-driven token re-issue; the operator can re-drive it",
    };

    const SEND_CALL = /\b(?:sendEmail|send[A-Za-z0-9]*Email)\s*\(/;
    // A "sent" instant PERSISTED to the database, which is the shape that can
    // consume a claim. `attempts`/`status` writes are not this.
    // Assigned SOMETHING — `now`, `new Date()`, `issuedAt` — and never `true`
    // (a Prisma `select`) or `null` (a filter, or a claim being handed back).
    const SENT_STAMP =
      /\b[A-Za-z]*[sS]entAt\s*:\s*(?!true\b|false\b|null\b|undefined\b)[A-Za-z_{(]/;
    const INSPECTION_EVIDENCE = [
      /\.status === "sent"/,
      /\.status !== "sent"/,
      /outcome\.status/,
      /emailPolicy\.kind === "withhold"/,
      /delivery\.kind/,
      // `email/core.ts` IS the decider: it reads its own gates rather than a
      // returned outcome.
      /environmentGate\.decision !== "send"/,
    ];

    const senders = walk(SRC)
      .map((file) => ({ file: repoRelative(file), text: readFileSync(file, "utf8") }))
      .filter(({ text }) => SEND_CALL.test(text) && SENT_STAMP.test(text))
      .map(({ file, text }) => ({ file, text }))
      .sort((a, b) => a.file.localeCompare(b.file));

    /*
      Anti-vacuity, in two halves. A narrowed pattern that matched nothing would
      leave this case asserting an empty list against an empty list, which is the
      exact shape that has gone quietly green in this epic before — so there is a
      floor. And every file NAMED below has to be found, so a list entry cannot
      quietly stop describing anything.
    */
    const found = senders.map(({ file }) => file);
    expect(
      found.length,
      "almost no stamp-writing senders were found, so this census checked nothing",
    ).toBeGreaterThan(8);
    expect(
      [...INSPECTS_THE_OUTCOME, ...Object.keys(RATE_LIMIT_STAMP_ONLY)]
        .filter((file) => !found.includes(file))
        .sort(),
      "these files are listed below but no longer match the send-and-stamp " +
        "shape, so their entries assert nothing. Remove them from the list.",
    ).toEqual([]);

    const unacknowledged = senders
      .map(({ file }) => file)
      .filter(
        (file) =>
          !INSPECTS_THE_OUTCOME.includes(file) && !(file in RATE_LIMIT_STAMP_ONLY),
      );
    expect(
      unacknowledged,
      "This module both sends a message and persists a 'sent' timestamp. " +
        "`sendEmail` RETURNS rather than throws when nothing was transmitted — an " +
        "environment withhold, a suppressed address, a walk-in placeholder — so a " +
        "stamp written without inspecting the outcome records a message that never " +
        "went out. Where the stamp is what the selecting query filters on, the " +
        "message is then lost permanently. Inspect the outcome and add the file to " +
        "INSPECTS_THE_OUTCOME, or, if the stamp is a re-send throttle rather than a " +
        "one-shot claim, add it to RATE_LIMIT_STAMP_ONLY with that reason " +
        "(INV-CONFIG-004).",
    ).toEqual([]);

    // Every acknowledged inspector must still LOOK like one. A shape check, not a
    // behaviour check — the behaviour is pinned in each caller's own suite — but it
    // is what notices the handling being deleted wholesale.
    const noLongerInspecting = INSPECTS_THE_OUTCOME.filter((file) => {
      const sender = senders.find((entry) => entry.file === file);
      if (!sender) return true;
      return !INSPECTION_EVIDENCE.some((pattern) => pattern.test(sender.text));
    });
    expect(
      noLongerInspecting,
      "These modules are recorded as inspecting the mailer's outcome and no " +
        "longer appear to (or no longer write a sent-timestamp at all). Update the " +
        "lists in this case rather than leaving one asserting something untrue.",
    ).toEqual([]);

    /*
      THE STATED BLIND SPOT, pinned by hand. A claim does not have to be a
      timestamp, and the worst instance of this class is not one: the age-up cron
      commits a tier flip, a login and a minted invitation token, and its own
      re-check then skips the member for good. There is no general shape for
      "consumed a claim", so the two claimants that are not timestamps are named
      here and each must still show it reads the outcome.
    */
    const NON_TIMESTAMP_CLAIMANTS: Record<string, string> = {
      "src/lib/cron-age-up.ts":
        "the tier flip, the login and the minted invitation token ARE the claim; a withheld invitation is rolled back",
      "src/lib/booking-request-quotes.ts":
        "reports emailDelivered to the officer who pressed Send, and audits on it",
    };
    const claimantsNotInspecting = Object.keys(NON_TIMESTAMP_CLAIMANTS).filter(
      (file) => {
        const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
        return (
          !SEND_CALL.test(text) ||
          !INSPECTION_EVIDENCE.some((pattern) => pattern.test(text))
        );
      },
    );
    expect(
      claimantsNotInspecting,
      "These modules consume a one-shot claim that is not a timestamp, so the " +
        "shape census above cannot see them. Each must still inspect the mailer's " +
        "outcome before it advances state (INV-CONFIG-004).",
    ).toEqual([]);
  });

  /**
   * The retry ceiling is one number in three files, and they must agree (#3035).
   *
   * The email retry cron stops at `MAX_ATTEMPTS`; the operator review queue
   * selects `attempts >= EMAIL_FAILURE_MAX_ATTEMPTS`; and the mail gate writes a
   * body-less blocked row AT the ceiling so it leaves the first query and enters
   * the second. If those three drift the row lands in NEITHER — which is exactly
   * the state this issue found and fixed, where a blocked sensitive-template row
   * sat at `attempts: 1`, below the review threshold and outside the retry query,
   * visible nowhere at all.
   *
   * They are three separate constants rather than one import because
   * `cron-email-retry.ts` imports `@/lib/email` for its failure alert, so the
   * mailer importing the cron's constant would be a cycle. This is the guard that
   * makes the duplication safe.
   */
  it("keeps the retry ceiling identical in the cron, the gate and the review queue", () => {
    const declarations: [string, RegExp][] = [
      ["src/lib/cron-email-retry.ts", /const MAX_ATTEMPTS = (\d+);/],
      ["src/lib/email/environment-gate.ts", /const EMAIL_RETRY_CEILING = (\d+);/],
      [
        "src/lib/email-failure-review.ts",
        /const EMAIL_FAILURE_MAX_ATTEMPTS = (\d+);/,
      ],
    ];
    const values = declarations.map(([file, pattern]) => {
      const match = readFileSync(
        path.resolve(process.cwd(), file),
        "utf8",
      ).match(pattern);
      // Anti-vacuity: an unmatched pattern would otherwise contribute `undefined`
      // and a set of one, which passes.
      expect(match?.[1], `${file} no longer declares its attempt ceiling`).toBeDefined();
      return `${file}=${match?.[1]}`;
    });
    expect(
      new Set(values.map((value) => value.split("=")[1])).size,
      `the retry ceiling disagrees across ${values.join(", ")}. A body-less ` +
        "blocked row is written AT the ceiling so it drops out of the retry query " +
        "and lands in the operator review queue; if these three numbers differ it " +
        "lands in neither and the message is silently lost (INV-CONFIG-004).",
    ).toBe(1);
  });

  /**
   * The clearance witness is stamped in exactly two functions, both of which read
   * the real sources (#3035 review).
   *
   * THE HOLE THIS CLOSES. `decideDeliveryPolicy` is exported and pure — it takes
   * an `EnvironmentRoleResolution` the CALLER supplies. While it also minted the
   * token, anybody could hand it `{ role: "PRODUCTION" }` and receive a genuine
   * `LiveProviderClearance` carrying the real module-private witness. No cast is
   * involved, so the cast census above does not fire; the send path survives
   * because `getEmailTransporter` re-resolves, but `sendXeroInvoiceEmail` checks
   * the witness ONLY — and a review lens drove `accountingApi.emailInvoice` to a
   * real call that way, on an installation whose real declaration was
   * `non-production`.
   *
   * So the module's central claim ("there is no other way to produce the
   * argument") is only true while the mint is unreachable from caller-supplied
   * input. This asserts the shape that makes it so: the two `mint*` helpers are
   * private, and they are called from `resolveDeliveryPolicy` alone.
   */
  it("stamps the clearance witness only where the real sources are read", () => {
    const policy = readFileSync(
      path.resolve(process.cwd(), POLICY_MODULE),
      "utf8",
    );

    /*
      The witness symbol is given a VALUE in the two mint helpers and nowhere
      else. Keyed on the string literal rather than on the property name, because
      `type MintedClearance = { readonly [CLEARANCE_WITNESS]: DeliveryGrounds }`
      names the property too and is a type, not a stamp.
    */
    const writers = [...policy.matchAll(/\[CLEARANCE_WITNESS\]:\s*"/g)];
    expect(
      writers.length,
      "the clearance witness must be stamped in exactly the two mint helpers",
    ).toBe(2);

    // Neither helper is exported, so no caller can reach one directly.
    for (const helper of ["mintLiveProviderClearance", "mintCaptureClearance"]) {
      expect(policy).toContain(`function ${helper}(`);
      expect(
        policy,
        `${helper} must stay module-private: exporting it hands out the token`,
      ).not.toContain(`export function ${helper}`);
    }

    /*
      And they are CALLED only inside `resolveDeliveryPolicy`, which reads the
      role and the transport from their canonical resolvers rather than taking
      them as arguments. Bounded to that function's body, because an unbounded
      search would be satisfied by a call from the pure function — which is the
      exact defect.
    */
    const start = policy.indexOf("export async function resolveDeliveryPolicy(");
    expect(start, "resolveDeliveryPolicy must still be defined").toBeGreaterThan(-1);
    const rest = policy.slice(start);
    const end = rest.indexOf("\n}\n");
    expect(end, "resolveDeliveryPolicy must have a closing brace").toBeGreaterThan(0);
    const body = rest.slice(0, end);
    for (const helper of ["mintLiveProviderClearance", "mintCaptureClearance"]) {
      expect(
        body,
        `${helper} must be called from resolveDeliveryPolicy, which reads the real sources`,
      ).toContain(`${helper}()`);
      // Once, and only from there. The lookbehind excludes the helper's own
      // declaration, which is also spelled `name()` before its return type.
      expect(
        [...policy.matchAll(new RegExp(`(?<!function )${helper}\\(\\)`, "g"))]
          .length,
        `${helper} must be called exactly once, inside resolveDeliveryPolicy`,
      ).toBe(1);
    }

    // The pure decision function must not name either helper at all.
    const pureStart = policy.indexOf("export function decideDeliveryPolicy(");
    expect(pureStart).toBeGreaterThan(-1);
    const pureRest = policy.slice(pureStart);
    const pureBody = pureRest.slice(0, pureRest.indexOf("\n}\n"));
    expect(pureBody.length, "decideDeliveryPolicy's body must be bounded").toBeGreaterThan(
      200,
    );
    for (const helper of ["mintLiveProviderClearance", "mintCaptureClearance"]) {
      expect(
        pureBody,
        "decideDeliveryPolicy takes caller-supplied input, so it must mint nothing " +
          "(INV-CONFIG-004)",
      ).not.toContain(helper);
    }
  });

  it("mints or casts a delivery clearance in exactly one module", () => {
    /*
      The cast shapes that defeat the brand: `as DeliveryClearance` and
      `<DeliveryClearance>`. The TYPE NAME alone is deliberately not matched —
      every consumer names it in a parameter type, which is the whole point of
      the design — so this looks for the assertion syntax only.

      BOTH BRANDS, and the second one is the important one. The first version
      matched `DeliveryClearance` only, so `as unknown as LiveProviderClearance`,
      `as LiveProviderClearance` and `<LiveProviderClearance>` were all MISSED
      (probed) — and that is the NARROWER, stronger token, the only one that opens
      the Xero invoice-email path to a real member's real inbox. The expectation
      is unchanged at `[POLICY_MODULE]`, so the alternation costs nothing.
    */
    const casts = filesMatching(
      /\bas\s+(?:unknown\s+as\s+)?(?:Delivery|LiveProvider)Clearance\b|<(?:Delivery|LiveProvider)Clearance>/,
    );
    expect(
      casts,
      "A DeliveryClearance may only be produced inside " +
        `${POLICY_MODULE}, and only on the branch where the environment role ` +
        "resolved PRODUCTION. Casting one elsewhere forges the proof that this " +
        "installation is the club's live site. The policy module still refuses " +
        "a forged token at runtime, so such a cast throws rather than sends — " +
        "but it must not reach review at all. Call resolveDeliveryPolicy() and " +
        "use the clearance from its allow branch (INV-CONFIG-004).",
    ).toEqual([POLICY_MODULE]);
  });
});
