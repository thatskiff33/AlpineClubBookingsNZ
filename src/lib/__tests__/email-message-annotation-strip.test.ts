import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFINITIONS } from "@/lib/email-message-registry";
import {
  findBracketAnnotations,
  findShippedAnnotations,
  SHIPPED_ANNOTATIONS,
  SHIPPED_ANNOTATION_PATTERN,
  SHIPPED_ANNOTATION_STRIP_PATTERNS,
  stripShippedAnnotations,
} from "@/lib/email-message-token-contract";

/**
 * #2269 (F3) — the strip that heals clubs whose SAVED override still carries
 * the "[only when …]" authoring notes this project used to ship inside its
 * default bodies, and the audit trail that records what we changed.
 *
 * Three things have to be true and none of them is provable by testing the
 * TypeScript alone:
 *
 *   1. the transformation is right on bodies that look like real ones — both
 *      what it removes and, far more importantly, what it must NOT touch;
 *   2. the migration that runs in production does the SAME transformation;
 *   3. the migration writes the audit entry the issue's acceptance criterion is
 *      actually about, one per row it really changed.
 *
 * (2) and (3) are why this file reads the migration SQL off disk. The strip
 * assertions lift the regex patterns OUT of it and run the corpus through
 * those; the audit assertions read the INSERT itself, because deleting the
 * whole audit half of the migration used to leave every test in this file
 * passing.
 *
 * WHAT THE PARITY HALF PROVES, AND WHAT IT DOES NOT (#2418). Lifting the
 * patterns out and re-running them in JavaScript proves the SQL and the
 * TypeScript agree about the patterns. It does NOT prove PostgreSQL executes
 * them the same way: the two regex dialects are close cousins, not twins, and
 * differ on greediness, on whether a character class matches a newline, and on
 * what a backslash means inside brackets. Only the PostgreSQL block at the
 * bottom of this file settles that, which is why it must stay wired in CI.
 * Migrations written after #2418 make that half a fixture under
 * prisma/migration-verification/ instead, so a missing one fails the build
 * rather than depending on a reviewer noticing an absent CI step.
 */

const MIGRATION_SQL_PATH = path.join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260801150000_strip_email_override_bracket_annotations",
  "migration.sql",
);

const migrationSql = readFileSync(MIGRATION_SQL_PATH, "utf8");

/** The dollar-quoted alternation the migration's "annotation" CTE holds. */
function sqlAnnotationPattern(): string {
  const match = migrationSql.match(/\$ann\$([\s\S]*?)\$ann\$/);
  if (!match) throw new Error("migration.sql has no $ann$…$ann$ alternation");
  return match[1];
}

/**
 * The six pass patterns the migration's "patterns" CTE builds, rebuilt exactly
 * as PostgreSQL would: each is a chain of single-quoted literals and
 * `annotation."span"` references concatenated with `||`.
 */
function sqlStripPatternSequence(): string[] {
  const cte = migrationSql.slice(
    migrationSql.indexOf("patterns AS ("),
    migrationSql.indexOf("targets AS ("),
  );
  const span = sqlAnnotationPattern();
  return Array.from(cte.matchAll(/^\s{4}(.+?) AS "pass\d"/gm), (match) =>
    match[1]
      .split("||")
      .map((piece) => piece.trim())
      .map((piece) => {
        if (piece === 'annotation."span"') return span;
        const literal = piece.match(/^'([^']*)'$/);
        if (!literal) {
          throw new Error(`unexpected pass expression fragment: ${piece}`);
        }
        return literal[1];
      })
      .join(""),
  );
}

/** Run a value through the patterns lifted out of the migration SQL. */
function stripUsingMigrationSql(value: string): string {
  return sqlStripPatternSequence().reduce(
    (current, pattern) => current.replace(new RegExp(pattern, "g"), ""),
    value,
  );
}

// Bodies a club could actually be holding. Every "before" that carries an
// annotation carries a VERBATIM shipped one (recovered from the history of
// email-message-audit-defaults.ts), because that is exactly what the editor
// pre-filled the textarea with and what a club saved.
const CORPUS: Array<{
  name: string;
  before: string;
  after: string;
}> = [
  {
    name: "booking-confirmed, with the club's own greeting and closing line kept",
    before: [
      "Booking Confirmed",
      "",
      "Kia ora {{firstName}}, your hut booking is locked in!",
      "",
      "Check-in: {{checkIn}}",
      "Guests: {{guestCount}}",
      "Subtotal: {{subtotal}}                  [only when discountCents > 0]",
      "Discount ({{promoCode}}): -{{discount}} [only when promoCode exists]",
      "Discount: -{{discount}}                 [only when discount exists without promoCode]",
      "Total Paid: {{totalPaid}}",
      "",
      "{{provisionalGuestsNote}} [only when non-member guests are held provisionally as a split linked booking]",
      "",
      "Door code: {{doorCode}} [only when a door code is set]",
      "",
      "Remember to sign the hut book on arrival.",
    ].join("\n"),
    after: [
      "Booking Confirmed",
      "",
      "Kia ora {{firstName}}, your hut booking is locked in!",
      "",
      "Check-in: {{checkIn}}",
      "Guests: {{guestCount}}",
      "Subtotal: {{subtotal}}",
      "Discount ({{promoCode}}): -{{discount}}",
      "Discount: -{{discount}}",
      "Total Paid: {{totalPaid}}",
      "",
      "{{provisionalGuestsNote}}",
      "",
      "Door code: {{doorCode}}",
      "",
      "Remember to sign the hut book on arrival.",
    ].join("\n"),
  },
  {
    name: "booking-modified, column-padded annotations from both families",
    before: [
      "Previous Dates: {{oldCheckIn}} – {{oldCheckOut}} [only when dates changed]",
      "Dates: {{newCheckIn}} – {{newCheckOut}}           [when dates did not change]",
      "Previous Guests: {{oldGuestCount}}                [only when guest count changed]",
      "Guests: {{newGuestCount}}                         [when guest count did not change]",
      "Total: {{newTotal}}                               [when total did not change]",
      "Change Fee: {{changeFee}}                         [only when changeFeeCents > 0]",
    ].join("\n"),
    after: [
      "Previous Dates: {{oldCheckIn}} – {{oldCheckOut}}",
      "Dates: {{newCheckIn}} – {{newCheckOut}}",
      "Previous Guests: {{oldGuestCount}}",
      "Guests: {{newGuestCount}}",
      "Total: {{newTotal}}",
      "Change Fee: {{changeFee}}",
    ].join("\n"),
  },
  {
    name: "school attendee confirmation, quotes and apostrophes inside the note",
    before:
      "Hi {{firstName}}, {{schoolName}}'s stay is coming up. Please tell us who is coming. [falls back to \"your school group's stay\" when no school name is recorded]\n\nConfirm Attendees: {{BASE_URL}}/school-bookings/confirm/{{token}}",
    after:
      "Hi {{firstName}}, {{schoolName}}'s stay is coming up. Please tell us who is coming.\n\nConfirm Attendees: {{BASE_URL}}/school-bookings/confirm/{{token}}",
  },
  {
    name: "a heading annotation, which only ever appeared in a subject",
    before:
      'Confirm Your Attendee List [heading becomes "Reminder: Confirm Your Attendee List" on reminders]',
    after: "Confirm Your Attendee List",
  },
  {
    name: "two annotations on one line, one of them embedding a token",
    before:
      "The duplicate charge was refunded in full. [when the automatic refund could not complete inline: the refund could not complete and a durable recovery operation is queued — the payment recovery cron will retry it with backoff; watch the recovery queue and confirm the refund lands. Failure detail: {{errorMessage}}]\n\nAmount refunded: {{amount}} [only when provided] today.",
    after:
      "The duplicate charge was refunded in full.\n\nAmount refunded: {{amount}} today.",
  },
  {
    name: "an annotation on the first line, on a line of its own, and at the start of a line with content after it",
    before: [
      "[only when localUrl exists]",
      "Repeated Xero Failures",
      "  [only when xeroObjectUrl exists]",
      "Open local record [only when localUrl exists]",
      "[only when xeroObjectUrl exists] Open Xero object",
    ].join("\n"),
    after: ["Repeated Xero Failures", "Open local record", "Open Xero object"].join(
      "\n",
    ),
  },
  {
    name: "a whole-line annotation between two blank lines takes one blank with it",
    // Otherwise the club's paragraph break becomes two blank lines in the
    // delivered email, which is a visible change to their layout.
    before: "Para one.\n\n[only when provided]\n\nPara two.",
    after: "Para one.\n\nPara two.",
  },
  {
    name: "a run of whole-line annotations between two blank lines",
    before:
      "Para one.\n\n[only when provided]\n[only when reason exists]\n\nPara two.",
    after: "Para one.\n\nPara two.",
  },
  {
    name: "a whole-line annotation at the very start, followed by a blank line",
    before: "[only when provided]\n\nHi {{firstName}}.",
    after: "Hi {{firstName}}.",
  },
  {
    name: "no brackets at all — must come back byte-identical",
    before: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
    after: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
  },
  {
    name: "club-authored brackets only — deliberate wording, never touched",
    before:
      "Hi {{guestName}},\n\nYour chores [see the noticeboard in the drying room] are below.\n\nBring your own [sleeping bag and pillowcase].",
    after:
      "Hi {{guestName}},\n\nYour chores [see the noticeboard in the drying room] are below.\n\nBring your own [sleeping bag and pillowcase].",
  },
  {
    name: "a shipped annotation and a club-authored bracket on the same row",
    before:
      "Expected arrival: {{expectedArrivalTime}} [only when provided]\n\nBring your own [sleeping bag and pillowcase].",
    after:
      "Expected arrival: {{expectedArrivalTime}}\n\nBring your own [sleeping bag and pillowcase].",
  },
];

/**
 * The reason this migration matches exact strings rather than a prefix family.
 * Every line below is club prose a prefix rule deleted when three reviewers
 * ran it, and the third one survives a word-boundary fix as well, because it
 * genuinely has the same shape as a shipped note. None of it may be touched.
 */
const CLUB_PROSE_THAT_MUST_SURVIVE: string[] = [
  "Ring the bell [whenever you arrive after 8pm].",
  "Ngā mihi — the hut sits on [whenua administered by the rūnanga] so tread lightly.",
  "Ring the warden [whenever you are running late] and let us know.",
  "Ring the lodge [when you are 30 minutes away].",
  "Refunds [only when the committee agrees] are at our discretion.",
  "Chores are listed [see the noticeboard] in the drying room.",
  // An unterminated opener: we cannot know where the club meant it to end, so
  // it is left entirely alone rather than run on to the next bracket.
  "Sorry {{firstName}} [only when a refund is due\nWe review each case.\n[reviews these weekly]\nRegards, the club.",
  // Whitespace reflowed inside a shipped note: deliberately NOT healed. It
  // keeps showing up in #2320's bracket banner for a person to decide about.
  "Door code: {{doorCode}} [only  when a door code is set]",
  "Door code: {{doorCode}} [Only when a door code is set]",
];

describe("#2269 shipped-annotation strip", () => {
  it.each(CORPUS)("strips $name", ({ before, after }) => {
    expect(stripShippedAnnotations(before)).toBe(after);
  });

  it.each(CORPUS)(
    "produces the same result from the MIGRATION SQL for $name",
    ({ before, after }) => {
      // The patterns here come out of prisma/migrations/**/migration.sql, not
      // out of the TypeScript, so this is a statement about what production
      // will actually run.
      expect(stripUsingMigrationSql(before)).toBe(after);
    },
  );

  it.each(CLUB_PROSE_THAT_MUST_SURVIVE.map((value) => ({ value })))(
    "never touches club prose: $value",
    ({ value }) => {
      expect(stripShippedAnnotations(value)).toBe(value);
      expect(stripUsingMigrationSql(value)).toBe(value);
      // And it is never even SELECTED by the migration, so no row is written
      // and no audit entry claims we changed something we did not.
      expect(findShippedAnnotations(value)).toEqual([]);
    },
  );

  it("matches only exact shipped strings, never a prefix family", () => {
    expect(SHIPPED_ANNOTATIONS).toHaveLength(38);
    for (const annotation of SHIPPED_ANNOTATIONS) {
      expect(annotation.startsWith("[")).toBe(true);
      expect(annotation.endsWith("]")).toBe(true);
      // One line, one span: no interior "]" and no newline, which is what makes
      // an unterminated opener unmatchable.
      expect(annotation.slice(1, -1)).not.toContain("]");
      expect(annotation).not.toContain("\n");
    }
    // No entry may be a prefix of another, or JavaScript's leftmost-first
    // alternation and PostgreSQL's longest-match preference could disagree.
    for (const left of SHIPPED_ANNOTATIONS) {
      for (const right of SHIPPED_ANNOTATIONS) {
        if (left === right) continue;
        expect(right.startsWith(left)).toBe(false);
      }
    }
    // Every entry is matched by the built pattern, exactly and wholly.
    for (const annotation of SHIPPED_ANNOTATIONS) {
      expect(findShippedAnnotations(annotation)).toEqual([annotation]);
    }
  });

  it("uses exactly the TypeScript alternation and passes in the migration SQL", () => {
    expect(sqlAnnotationPattern()).toBe(SHIPPED_ANNOTATION_PATTERN);
    expect(sqlStripPatternSequence()).toEqual([
      ...SHIPPED_ANNOTATION_STRIP_PATTERNS,
    ]);
  });

  it("applies every pass to the subject and the body alike, in order", () => {
    // A pass applied to one field and not the other would leave half a row
    // healed, and re-ordering them silently changes the result.
    const applications = Array.from(
      migrationSql.matchAll(
        /regexp_replace\((?:targets|pass\d)\."(\w+)", patterns\."(pass\d)", '', 'g'\)/g,
      ),
      (match) => `${match[2]}:${match[1]}`,
    );
    expect(applications).toEqual([
      "pass1:subject",
      "pass1:bodyText",
      "pass2:newSubject",
      "pass2:newBody",
      "pass3:newSubject",
      "pass3:newBody",
      "pass4:newSubject",
      "pass4:newBody",
      "pass5:newSubject",
      "pass5:newBody",
      "pass6:newSubject",
      "pass6:newBody",
    ]);
  });

  it.each(CORPUS)("is idempotent for $name", ({ before }) => {
    const once = stripShippedAnnotations(before);
    const twice = stripShippedAnnotations(once);
    expect(twice).toBe(once);
    // The stronger statement: nothing the strip targets survives it, which is
    // what makes a re-run select no rows and write no second audit entry.
    expect(findShippedAnnotations(once)).toEqual([]);
  });

  it.each(CORPUS)(
    "never leaves trailing whitespace behind for $name",
    ({ before }) => {
      const stripped = stripShippedAnnotations(before);
      const offending = stripped
        .split("\n")
        .filter((line, index) => {
          if (!/[ \t]$/.test(line)) return false;
          // Only whitespace the strip CREATED counts; a club may have saved a
          // trailing space of its own and we do not touch it.
          return !/[ \t]$/.test(before.split("\n")[index] ?? "");
        });
      expect(offending).toEqual([]);
    },
  );

  it.each(CORPUS)("never grows a run of blank lines for $name", ({ before }) => {
    const stripped = stripShippedAnnotations(before);
    const runs = (value: string) => (value.match(/\n{3,}/g) ?? []).length;
    expect(runs(stripped)).toBeLessThanOrEqual(runs(before));
  });

  it("changes nothing at all when there is nothing to strip", () => {
    // The identity property is what lets the migration write an audit row only
    // for rows it genuinely changed: no identity, no honest audit trail.
    for (const { before, after } of CORPUS) {
      if (findShippedAnnotations(before).length > 0) continue;
      expect(after).toBe(before);
      expect(stripShippedAnnotations(before)).toBe(before);
    }
  });

  it("reports exactly the annotations it removes", () => {
    const before = CORPUS[0].before;
    expect(findShippedAnnotations(before)).toEqual([
      "[only when discountCents > 0]",
      "[only when promoCode exists]",
      "[only when discount exists without promoCode]",
      "[only when non-member guests are held provisionally as a split linked booking]",
      "[only when a door code is set]",
    ]);
  });

  it("leaves club-authored brackets for #2320's banner rather than deleting them", () => {
    const clubText =
      "Your chores [see the noticeboard] are below. [only when chores exist]";
    const stripped = stripShippedAnnotations(clubText);
    expect(stripped).toBe("Your chores [see the noticeboard] are below.");
    // Guard 1 (#2320) still flags what is left, so the admin decides.
    expect(
      findBracketAnnotations({
        "chore-roster": { defaultSubject: "", defaultBody: stripped },
      }),
    ).toEqual([
      {
        key: "chore-roster",
        field: "defaultBody",
        detail: "[see the noticeboard]",
      },
    ]);
  });

  it("is a no-op on every current shipped default", () => {
    // #2267 and #2268 removed the annotations from the code defaults. If one
    // ever comes back, the migration would silently start rewriting overrides
    // that copied it — so pin the two halves together here.
    for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
      expect(stripShippedAnnotations(definition.defaultSubject)).toBe(
        definition.defaultSubject,
      );
      expect(stripShippedAnnotations(definition.defaultBody)).toBe(
        definition.defaultBody,
      );
    }
  });

  it("selects candidate rows by the same alternation it strips with", () => {
    // If the row filter drifted from the strip, a row could be selected and not
    // changed (a false audit row) or changed and not listed.
    const detection = Array.from(
      migrationSql.matchAll(/~ annotation\."span"/g),
    );
    expect(detection).toHaveLength(2); // subject and bodyText
    expect(migrationSql).toContain(
      `WHERE COALESCE(override."subject", '') ~ annotation."span"`,
    );
    expect(migrationSql).toContain(
      `OR COALESCE(override."bodyText", '') ~ annotation."span"`,
    );
  });
});

/**
 * The audit half of the acceptance criterion: "a per-mutated-row audit entry so
 * a club can see what we changed". None of it was covered before the #2269
 * review — the whole `audited` CTE could be deleted and every test above still
 * passed. These assertions are textual because the statement cannot be executed
 * without a PostgreSQL server, and they are deliberately specific enough that
 * deleting or weakening the INSERT fails them.
 */
describe("#2269 migration audit trail", () => {
  const auditInsert = migrationSql.slice(
    migrationSql.indexOf('INSERT INTO "AuditLog"'),
  );

  it("writes an AuditLog row at all", () => {
    expect(migrationSql).toContain('INSERT INTO "AuditLog"');
  });

  it("names every column it writes, including createdAt", () => {
    const columns = Array.from(
      auditInsert
        .slice(auditInsert.indexOf("("), auditInsert.indexOf(")"))
        .matchAll(/"(\w+)"/g),
      (match) => match[1],
    );
    expect(columns).toEqual([
      "id",
      "action",
      "targetId",
      "entityType",
      "entityId",
      "category",
      "severity",
      "outcome",
      "summary",
      "metadata",
      "retentionClass",
      "expiresAt",
      // #1627/#1656 class: left unnamed, "createdAt" takes the column default
      // CURRENT_TIMESTAMP, which writes the SESSION's local wall clock into a
      // naive column — 12 hours out on a Pacific/Auckland session.
      "createdAt",
    ]);
  });

  it("writes one row per row the UPDATE actually changed, and no other", () => {
    // The audit must be driven BY the update, not run beside it: an INSERT in a
    // parallel CTE cannot know whether the UPDATE hit the row, and produced an
    // audit entry for a template a concurrent Restore Default had just deleted.
    expect(migrationSql).toContain("RETURNING changed.*");
    expect(auditInsert).toContain("FROM updated");
    expect(auditInsert).not.toContain("FROM changed");
    // And the UPDATE only writes a row still holding what the strip was
    // computed from, so a concurrent admin save is never clobbered.
    expect(migrationSql).toContain(
      `AND override."subject" IS NOT DISTINCT FROM changed."oldSubject"`,
    );
    expect(migrationSql).toContain(
      `AND override."bodyText" IS NOT DISTINCT FROM changed."oldBody"`,
    );
  });

  it("records the whole previous row and the whole new content", () => {
    // This is what makes the change recoverable by a club that disagrees with
    // it, which is the entire point of auditing a silent content rewrite.
    for (const fragment of [
      `'previousOverride', jsonb_build_object(`,
      `'subject', updated."oldSubject"`,
      `'bodyText', updated."oldBody"`,
      `'newOverride', jsonb_build_object(`,
      `'subject', updated."newSubject"`,
      `'bodyText', updated."newBody"`,
      // Matches the EMAIL_TEMPLATE_OVERRIDE_UPDATED metadata the save route
      // writes, which carries updatedByMemberId on both sides.
      `'updatedByMemberId', updated."updatedByMemberId"`,
      `'source', 'migration:20260801150000_strip_email_override_bracket_annotations'`,
      `'issue', 2269`,
    ]) {
      expect(auditInsert).toContain(fragment);
    }
  });

  it("lists the removed annotations per field, never across a concatenation", () => {
    // subject || E'\n' || body invents spans that straddle the join: a subject
    // ending "Trailing opener [only when" and a body starting "x]" produced a
    // phantom entry naming an annotation that was never removed.
    expect(auditInsert).toContain("'removedAnnotations'");
    expect(auditInsert).toContain(
      `FROM (VALUES (1, updated."oldSubject"), (2, updated."oldBody"))`,
    );
    expect(auditInsert).toContain(
      `jsonb_agg(match."annotation"[1] ORDER BY field."rank", match."position")`,
    );
    expect(auditInsert).not.toMatch(/oldSubject"\s*\|\|/);
  });

  it("keeps the retention and action constants the app's audit builder uses", () => {
    expect(auditInsert).toContain("'EMAIL_TEMPLATE_OVERRIDE_UPDATED'");
    expect(auditInsert).toContain("'EmailTemplateOverride'");
    expect(auditInsert).toContain("'admin'");
    expect(auditInsert).toContain("'important'");
    expect(auditInsert).toContain("'success'");
    expect(auditInsert).toContain("'critical'");
    expect(auditInsert).toContain(
      `timezone('UTC', statement_timestamp()) + interval '7 years'`,
    );
  });

  it("never writes a session-local clock", () => {
    // Every timestamp this statement writes is explicitly UTC. A bare now() /
    // CURRENT_TIMESTAMP / LOCALTIMESTAMP would take the session's zone.
    const timestampWrites = Array.from(
      migrationSql
        .slice(migrationSql.indexOf("WITH annotation AS ("))
        .matchAll(/\b(now\(\)|CURRENT_TIMESTAMP|LOCALTIMESTAMP|clock_timestamp\(\))/gi),
    );
    expect(timestampWrites).toEqual([]);
    expect(migrationSql).toContain(`timezone('UTC', statement_timestamp())`);
  });

  it("renders metadata timestamps as ISO instants with a Z", () => {
    // jsonb_build_object on a naive timestamp emits "2026-01-01T00:00:00",
    // which JavaScript parses as LOCAL time; the app's sanitizer writes
    // toISOString().
    for (const field of ["createdAt", "updatedAt"]) {
      expect(auditInsert).toContain(
        `'${field}', to_char(updated."${field}", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      );
    }
  });

  it("normalises an emptied value to NULL rather than an empty string", () => {
    // '' is a state the app never stores, and #2269's own staleContent would
    // report it as "your saved copy differs" and diff the whole default.
    expect(migrationSql).toContain(`btrim(pass6."newSubject", E' \\t\\r\\n') = ''`);
    expect(migrationSql).toContain(`btrim(pass6."newBody", E' \\t\\r\\n') = ''`);
  });
});


// ---------------------------------------------------------------------------
// REAL-POSTGRESQL BEHAVIOUR (env-gated, disposable-schema-per-test).
//
// Why this exists (#2269 second review, and issue #2418, which was filed for
// exactly this gap). Every assertion above about the audit half is
// `expect(migrationSql).toContain(...)`: text, not behaviour. That was proven
// insufficient by mutation — changing `) AS found ON TRUE` to
// `) AS found ON TRUE WHERE FALSE` writes ZERO audit rows while keeping every
// asserted fragment intact, and the whole file still passed. So the audit half
// was pinned by string-matching only, and #2269's entire acceptance criterion —
// "a club can see that we changed their copy, what we changed, and can restore
// any of it" — rested on nothing executable.
//
// The pattern is the repo's existing one for a migration
// (src/lib/__tests__/xero-member-grouping-migration.test.ts): point the env var
// at a disposable database, and each test provisions its own PostgreSQL SCHEMA,
// creates only the columns this migration touches, runs the migration's own
// SQL, and drops the schema again. It is `describe.skip` without the variable,
// so `npm test` never needs a live database.
//
//   EMAIL_OVERRIDE_ANNOTATION_STRIP_TEST_DATABASE_URL=postgres://... \
//     npx vitest run src/lib/__tests__/email-message-annotation-strip.test.ts
// ---------------------------------------------------------------------------

const stripDatabaseUrl =
  process.env.EMAIL_OVERRIDE_ANNOTATION_STRIP_TEST_DATABASE_URL;
const describeWithDatabase = stripDatabaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// Only the columns this migration reads or writes. The real tables come from
// earlier migrations; modelling them here keeps the test independent of whether
// the target database has been migrated at all.
const PRE_EXISTING_SCHEMA_SQL = `
  CREATE TABLE "EmailTemplateOverride" (
    "id" TEXT PRIMARY KEY,
    "templateName" TEXT NOT NULL UNIQUE,
    "subject" TEXT,
    "bodyText" TEXT,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE "AuditLog" (
    "id" TEXT PRIMARY KEY,
    "action" TEXT NOT NULL,
    "memberId" TEXT,
    "targetId" TEXT,
    "actorMemberId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "category" TEXT,
    "severity" TEXT,
    "outcome" TEXT,
    "summary" TEXT,
    "metadata" JSONB,
    "retentionClass" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

type AuditRow = {
  action: string;
  targetId: string | null;
  actorMemberId: string | null;
  entityType: string | null;
  entityId: string | null;
  category: string | null;
  severity: string | null;
  outcome: string | null;
  summary: string | null;
  retentionClass: string | null;
  metadata: {
    templateName?: string;
    previousOverride?: Record<string, unknown>;
    newOverride?: Record<string, unknown>;
    removedAnnotations?: string[];
    source?: string;
    issue?: number;
  };
  createdAt: Date;
  expiresAt: Date | null;
};

async function withMigrationSchema(run: (client: Client) => Promise<void>) {
  const schemaName = `email_strip_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const client = new Client({ connectionString: stripDatabaseUrl });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // Test fixture: hardcoded DDL in a disposable per-test schema; no user input.
    await client.query(PRE_EXISTING_SCHEMA_SQL);
    await run(client);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

async function seedOverride(
  client: Client,
  row: { templateName: string; subject: string | null; bodyText: string | null },
) {
  await client.query(
    `INSERT INTO "EmailTemplateOverride"
       ("id", "templateName", "subject", "bodyText", "updatedByMemberId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'admin-7', TIMESTAMP '2026-01-01 00:00:00', TIMESTAMP '2026-02-02 00:00:00')`,
    [`ov-${row.templateName}`, row.templateName, row.subject, row.bodyText],
  );
}

async function runMigration(client: Client) {
  // Test fixture: runs the migration's own SQL against a disposable per-test
  // schema; no user input.
  await client.query(migrationSql);
}

async function readAudit(client: Client): Promise<AuditRow[]> {
  const result = await client.query<AuditRow>(
    `SELECT "action", "targetId", "actorMemberId", "entityType", "entityId",
            "category", "severity", "outcome", "summary", "retentionClass",
            "metadata", "createdAt", "expiresAt"
     FROM "AuditLog" ORDER BY "entityId"`,
  );
  return result.rows;
}

describeWithDatabase(
  "#2269 annotation strip — real PostgreSQL behaviour (#2418)",
  () => {
    // The exact wording this project shipped at 88b35fcc5, with the note padded
    // onto a line of pure prose. That line is why the editor needed a signal
    // derived from the audit row rather than from the deleted bracket.
    const SHIPPED_BODY = [
      "Hi {{firstName}}, your lodge booking has been confirmed!",
      "",
      "Payment has been processed successfully. [only when the booking is already paid]",
      "",
      "Subtotal: {{subtotal}}                  [only when discountCents > 0]",
      "",
      "Ring the lodge [when you are 30 minutes away].",
    ].join("\n");

    const STRIPPED_BODY = [
      "Hi {{firstName}}, your lodge booking has been confirmed!",
      "",
      "Payment has been processed successfully.",
      "",
      "Subtotal: {{subtotal}}",
      "",
      "Ring the lodge [when you are 30 minutes away].",
    ].join("\n");

    it("writes exactly one audit row per changed row, and none for a row it left alone", async () => {
      // THE MUTATION TEST. Neutering the audit INSERT (`) AS found ON TRUE
      // WHERE FALSE`) keeps every text assertion in this file green and fails
      // here, which is the whole point of executing the statement.
      await withMigrationSchema(async (client) => {
        await seedOverride(client, {
          templateName: "booking-confirmed",
          subject: "Booking Confirmed",
          bodyText: SHIPPED_BODY,
        });
        await seedOverride(client, {
          templateName: "chore-roster",
          subject: "Chore Roster",
          bodyText: "Hi {{guestName}}, nothing of ours in here.",
        });

        await runMigration(client);

        const overrides = await client.query<{
          templateName: string;
          subject: string | null;
          bodyText: string | null;
          updatedAt: Date;
        }>(
          `SELECT "templateName", "subject", "bodyText", "updatedAt"
           FROM "EmailTemplateOverride" ORDER BY "templateName"`,
        );
        expect(
          overrides.rows.find((row) => row.templateName === "booking-confirmed")
            ?.bodyText,
        ).toBe(STRIPPED_BODY);
        // The club's own bracketed wording survives byte for byte.
        expect(
          overrides.rows.find((row) => row.templateName === "booking-confirmed")
            ?.bodyText,
        ).toContain("Ring the lodge [when you are 30 minutes away].");
        // A row carrying none of our notes is not touched at all.
        expect(
          overrides.rows.find((row) => row.templateName === "chore-roster")
            ?.bodyText,
        ).toBe("Hi {{guestName}}, nothing of ours in here.");

        const audit = await readAudit(client);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          action: "EMAIL_TEMPLATE_OVERRIDE_UPDATED",
          targetId: "booking-confirmed",
          entityType: "EmailTemplateOverride",
          entityId: "booking-confirmed",
          category: "admin",
          severity: "important",
          outcome: "success",
          retentionClass: "critical",
          // No member did this.
          actorMemberId: null,
        });
      });
    });

    it("records the previous wording verbatim, the new wording, and the notes removed in order", async () => {
      // #2269's acceptance criterion, executed rather than asserted about.
      await withMigrationSchema(async (client) => {
        await seedOverride(client, {
          templateName: "booking-confirmed",
          subject: "Booking Confirmed [only when the booking is already paid]",
          bodyText: SHIPPED_BODY,
        });

        await runMigration(client);

        const [row] = await readAudit(client);
        expect(row.metadata.templateName).toBe("booking-confirmed");
        expect(row.metadata.source).toBe(
          "migration:20260801150000_strip_email_override_bracket_annotations",
        );
        expect(row.metadata.issue).toBe(2269);
        expect(row.metadata.previousOverride).toMatchObject({
          subject: "Booking Confirmed [only when the booking is already paid]",
          bodyText: SHIPPED_BODY,
          updatedByMemberId: "admin-7",
        });
        expect(row.metadata.newOverride).toMatchObject({
          subject: "Booking Confirmed",
          bodyText: STRIPPED_BODY,
        });
        // Subject first, then body, each in the order they appeared — and never
        // a phantom span straddling the join between the two fields.
        expect(row.metadata.removedAnnotations).toEqual([
          "[only when the booking is already paid]",
          "[only when the booking is already paid]",
          "[only when discountCents > 0]",
        ]);
      });
    });

    it("is idempotent: a second run changes nothing and writes no second audit row", async () => {
      await withMigrationSchema(async (client) => {
        await seedOverride(client, {
          templateName: "booking-confirmed",
          subject: "Booking Confirmed",
          bodyText: SHIPPED_BODY,
        });

        await runMigration(client);
        const first = await client.query<{ digest: string }>(
          `SELECT md5(string_agg("templateName" || coalesce("bodyText", '') || "updatedAt"::text, '|' ORDER BY "templateName")) AS digest
           FROM "EmailTemplateOverride"`,
        );

        await runMigration(client);
        const second = await client.query<{ digest: string }>(
          `SELECT md5(string_agg("templateName" || coalesce("bodyText", '') || "updatedAt"::text, '|' ORDER BY "templateName")) AS digest
           FROM "EmailTemplateOverride"`,
        );

        expect(second.rows[0].digest).toBe(first.rows[0].digest);
        expect(await readAudit(client)).toHaveLength(1);
      });
    });

    it("normalises a value the strip empties out to NULL, not an empty string", async () => {
      await withMigrationSchema(async (client) => {
        await seedOverride(client, {
          templateName: "admin-new-booking",
          subject: "  [only when reviewReason exists]  ",
          bodyText: "Kept.",
        });

        await runMigration(client);

        const result = await client.query<{ subject: string | null }>(
          `SELECT "subject" FROM "EmailTemplateOverride" WHERE "templateName" = 'admin-new-booking'`,
        );
        expect(result.rows[0].subject).toBeNull();
      });
    });

    it("writes UTC timestamps and a 7-year retention window", async () => {
      // The #1627/#1656 class: leaving "createdAt" to its column default writes
      // the SESSION's local wall clock into a naive column.
      await withMigrationSchema(async (client) => {
        await client.query(`SET TIME ZONE 'Pacific/Auckland'`);
        await seedOverride(client, {
          templateName: "booking-confirmed",
          subject: "Booking Confirmed",
          bodyText: SHIPPED_BODY,
        });

        await runMigration(client);

        const drift = await client.query<{ seconds: number; years: number }>(
          `SELECT
             abs(extract(epoch FROM ("createdAt" - timezone('UTC', now()))))::float8 AS seconds,
             extract(year FROM age("expiresAt", "createdAt"))::float8 AS years
           FROM "AuditLog"`,
        );
        // A session-clock write would land 12 or 13 hours out in this zone.
        expect(drift.rows[0].seconds).toBeLessThan(120);
        expect(drift.rows[0].years).toBe(7);
      });
    });

    it("leaves a row a concurrent admin re-saved entirely alone", async () => {
      // docs/UPGRADING.md promises this is safe to run with the previous app
      // colour still serving. The UPDATE re-checks that the row still holds the
      // wording the strip was computed from, so a Save that lands in that window
      // wins and gets no audit row claiming we changed it. Reproduced here by
      // rewriting the row between the seed and the migration.
      await withMigrationSchema(async (client) => {
        await seedOverride(client, {
          templateName: "booking-confirmed",
          subject: "Booking Confirmed",
          bodyText: SHIPPED_BODY,
        });
        await client.query(
          `UPDATE "EmailTemplateOverride" SET "bodyText" = 'Admin rewrote this entirely.'
           WHERE "templateName" = 'booking-confirmed'`,
        );

        await runMigration(client);

        const result = await client.query<{ bodyText: string | null }>(
          `SELECT "bodyText" FROM "EmailTemplateOverride" WHERE "templateName" = 'booking-confirmed'`,
        );
        expect(result.rows[0].bodyText).toBe("Admin rewrote this entirely.");
        expect(await readAudit(client)).toHaveLength(0);
      });
    });
  },
);
