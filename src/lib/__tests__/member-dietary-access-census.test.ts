/**
 * The member dietary/allergy access census (#2941, #3029, `INV-PRIV-022`).
 *
 * WHAT THIS GATE IS FOR. `Member.dietaryRequirements` and, since #3029, the
 * per-stay `BookingGuest.dietaryRequirements` are special-category personal
 * data, children's included. They are protected by RUNTIME absence, not by a
 * filter: every application Prisma client is constructed with
 * `omit: PRISMA_CLIENT_GLOBAL_OMIT`, so a Member or BookingGuest read that does
 * not ask for the column never carries it, and `src/lib/member-dietary.ts` is
 * the one module that asks, for a caller holding a grant — or, on the booking
 * write side, hands a writer an opaque decision it cannot read.
 *
 * `src/lib/prisma.ts` TYPES the client as the plain `PrismaClient` (an omit-typed
 * client is not assignable to `Prisma.TransactionClient`, and re-typing ~160
 * helpers was measured and rejected there). So the compiler still believes the
 * field is on every row. This census is a TEXT scan over `src/`, `scripts/`,
 * `prisma/` and `e2e/`, and it holds exactly these rules:
 *
 *  1. SELECT/OMIT: `dietaryRequirements: true|false` (a select, an include, a
 *     local `omit` override) appears only in the canonical module and the omit
 *     constant.
 *  2. RAW SQL: no file that issues raw SQL names the column, and no file reads a
 *     whole row (`SELECT *` in its spellings, `alias.*`, `TABLE "Member"`, a
 *     JSON row function). One classified exemption, fenced by column grants.
 *  3. CONSTRUCTOR: every `new …PrismaClient(`, including namespaced and aliased
 *     spellings, passes `omit: PRISMA_CLIENT_GLOBAL_OMIT`, except the seeds,
 *     E2E harnesses and the deploy rehearsal, each classified with its reason.
 *  4. REACH: in `src/`, the identifier's SPELLING outside comments is confined
 *     to a listed set of files.
 *  5. IMPORT: in every root, importing the canonical module is confined to a
 *     listed set of files, and no file re-exports a grant or reader.
 *  6. EGRESS: no file on any list sits on a Xero, analytics, notification,
 *     email, roster, lodge-screen, kiosk, family, booking, finance or logging
 *     path — except that a #3029 entry may be ALLOWED, by name, onto the booking
 *     or kiosk family, which is where the booking value is meant to be read.
 *     No entry can ever be allowed onto Xero, analytics, notifications, email,
 *     rosters or the lobby, family views, finance or logging.
 *  7. MERGE CALLERS: the merge engine mints a scoped merge grant internally and
 *     its preview returns both values, so calling it is confined to a listed set
 *     of files too.
 *  8. WRITE SIDE (#3029): the door's write half,
 *     `src/lib/member-dietary-booking-writes.ts`, is imported only by a closed
 *     list of booking writers, none of which may name a grant, reader or
 *     loader, and no file but the two boundary files writes the column by name.
 *     Every BookingGuest create site is on a closed list and hands its builder a
 *     dietary decision (`INV-MOD-059`).
 *
 * WHAT IT CANNOT SEE, stated so nobody reads it as stronger than it is. It
 * matches text, not data flow. A listed file that reads `.dietaryRequirements`
 * off an ordinary row gets `undefined` (never the value) and stays green; so
 * does code that walks a row's keys generically. A value, once a listed file
 * holds it, can be passed on to anything; rules 5 and 6 confine who can obtain
 * it, not where it goes next. Those are review's job, and INV-PRIV-022 says so.
 *
 * Scanned from disk, so `vitest related` cannot reach it: run it by name,
 * `npm run test:named -- src/lib/__tests__/member-dietary-access-census.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRISMA_CLIENT_GLOBAL_OMIT } from "@/lib/prisma-global-omit";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

const INVARIANT_ID = "INV-PRIV-022";
const LIFECYCLE_INVARIANT_ID = "INV-MOD-059";
const REPO_ROOT = path.resolve(__dirname, "../../..");

const CANONICAL_MODULE = "src/lib/member-dietary.ts";
/**
 * The same boundary's write half (#3029), split from the door only for size. It
 * may select and write the column like the door, but it mints no grant, and it
 * is imported through its own closed list (`BOOKING_WRITES_IMPORTERS`).
 */
const BOOKING_WRITES_MODULE = "src/lib/member-dietary-booking-writes.ts";
/** Files allowed to select, omit-override or write the column by name. */
const COLUMN_OWNERS: ReadonlySet<string> = new Set([CANONICAL_MODULE, BOOKING_WRITES_MODULE]);
const OMIT_CONSTANT_MODULE = "src/lib/prisma-global-omit.ts";

/**
 * Rule 6's surfaces, by family. Stage 1 listed them as one set; #3029 names the
 * families so a booking-value entry can be allowed onto `booking` or `kiosk`
 * (where the value is meant to be read) without being allowed onto anything
 * else. The kiosk family was split out of the lodge-screen one for exactly
 * that: the kiosk day list is an authorised audience, the roster and the lobby
 * wall are not.
 */
const EGRESS_SURFACES = {
  xero: /xero/i,
  analytics: /analytics|gtag|telemetry/i,
  notification: /notification|email|mailer|\bmail\b/i,
  "lodge-screen": /roster|lodge-screen|lobby/i,
  kiosk: /kiosk|hut-leader/i,
  family: /family/i,
  booking: /booking/i,
  finance: /finance|payment|invoice/i,
  logging: /sentry|logger/i,
} as const;
type EgressFamily = keyof typeof EGRESS_SURFACES;

/** The ONLY families an entry may be allowed onto. */
const ALLOWABLE_EGRESS_FAMILIES = ["booking", "kiosk"] as const;
type AllowableEgressFamily = (typeof ALLOWABLE_EGRESS_FAMILIES)[number];

/**
 * A list entry: a reason, or (#3029) a reason plus the named families it may
 * sit on, and — for an importer — whether it takes the module's write half
 * only. A `write` importer may not name a grant, reader or loader at all.
 */
type CensusEntry =
  | string
  | {
      readonly reason: string;
      readonly allow: readonly AllowableEgressFamily[];
      readonly side?: "write" | "read";
    };

function allowedFamilies(entry: CensusEntry | undefined): readonly string[] {
  return typeof entry === "object" ? entry.allow : [];
}

/** The families a path sits on, minus the ones its entry is allowed onto. */
function unallowedEgress(file: string, entry: CensusEntry | undefined): EgressFamily[] {
  const allow = allowedFamilies(entry);
  return (Object.keys(EGRESS_SURFACES) as EgressFamily[]).filter(
    (family) => EGRESS_SURFACES[family].test(file) && !allow.includes(family),
  );
}

const BOOKING = { allow: ["booking"] } as const;
const KIOSK = { allow: ["kiosk"] } as const;
const WRITE_SIDE = { allow: ["booking"], side: "write" } as const;

/**
 * Rule 4's list: every application file allowed to SPELL
 * `dietaryRequirements` outside a comment, and why.
 */
const DIETARY_REACH: Readonly<Record<string, CensusEntry>> = {
  [CANONICAL_MODULE]: "the one door: grants, selects and the write patch",
  [BOOKING_WRITES_MODULE]: {
    reason: "the door's write half: seeds, carries and rewrites booking values (#3029)",
    ...BOOKING,
  },
  [OMIT_CONSTANT_MODULE]: "the client-wide omission itself",
  "src/components/member-dietary-requirements-field.tsx":
    "the one input, shared by self and admin screens",
  "src/app/api/profile/route.ts": "self writer (profile and onboarding)",
  "src/app/(authenticated)/profile/page.tsx": "self reader, ON only",
  "src/app/(authenticated)/profile/profile-details-card.tsx":
    "passes the self value to the form",
  "src/app/(authenticated)/profile/profile-form.tsx":
    "self form state; sends the key only while ON",
  "src/app/api/member/onboarding/route.ts": "self reader for onboarding, ON only",
  "src/components/member-onboarding-wizard.tsx": "onboarding form props",
  "src/app/api/member/data-export/route.ts":
    "the subject's own full export (ON or OFF, owner decision 20 Sep 2026)",
  "src/lib/admin-member-detail-service.ts":
    "membership-admin detail reader and editor writer",
  "src/lib/admin-member-edit-groups.ts": "admin Contact group form/payload",
  "src/app/(admin)/admin/members/[id]/_types.ts": "admin detail DTO type",
  "src/app/(admin)/admin/members/[id]/_components/member-contact-group.tsx":
    "admin Contact group display/editor",
  "src/lib/admin-members-service.ts": "membership-admin create writer",
  "src/app/(admin)/admin/members/_types.ts": "admin create form type",
  "src/app/(admin)/admin/members/_utils.ts": "admin create form default",
  "src/app/(admin)/admin/members/_components/member-editor-dialog.tsx":
    "admin create (never edit-from-list, whose DTO has no value)",
  "src/lib/member-csv-import.ts": "member CSV import parser",
  "src/app/api/admin/members/import/route.ts":
    "member CSV import writer, ON and membership:edit only",
  "src/lib/member-merge-field-rules.ts": "fill-if-blank merge rule",
  "src/lib/member-merge-field-kinds.ts": "merge screen value kind",
  // #3029: the booking value's readers. None WRITES the column by name (rule 8).
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-guest-dietary.ts": {
    reason: "booking-admin reader (R1): mints the grant, returns rows to the page",
    ...BOOKING,
  },
  "src/app/(authenticated)/bookings/[id]/_components/booking-guest-dietary-card.tsx": {
    reason: "booking-admin card: displays and edits one stay's values",
    ...BOOKING,
  },
  "src/app/api/admin/bookings/[id]/guest-dietary/route.ts": {
    reason: "the one booking-value edit route (R4), bookings:edit",
    ...BOOKING,
  },
  "src/app/(lodge)/lodge/kiosk/page.tsx": {
    reason: "kiosk day list display; the key is absent for every denied tier",
    ...KIOSK,
  },
};

/**
 * Rule 5: the closed list of files that IMPORT the canonical module. Naming the
 * field is not the only way to reach the value: a file can mint a grant and
 * call a reader without ever spelling `dietaryRequirements`, so the import is
 * confined too, and every entry here is also checked against the egress
 * patterns.
 */
const DIETARY_MODULE_IMPORTERS: Readonly<Record<string, CensusEntry>> = {
  "src/app/(authenticated)/profile/page.tsx": "self display grant",
  "src/app/api/profile/route.ts": "self write (profile and onboarding)",
  "src/app/api/member/onboarding/route.ts": "self display grant",
  "src/app/api/member/data-export/route.ts": "self data-export grant",
  "src/app/api/admin/members/[id]/route.ts": "membership grant from requireAdmin",
  "src/app/api/admin/members/route.ts": "membership grant for create",
  "src/app/api/admin/members/export/route.ts": "membership grant for the CSV column",
  "src/app/api/admin/members/import/route.ts": "membership grant for the CSV column",
  "src/app/api/admin/deletion-requests/[id]/route.ts":
    "the erasure patch only (no grant, no read)",
  "src/lib/admin-member-detail-service.ts": "admin detail read and edit",
  "src/lib/admin-members-service.ts": "admin create write",
  "src/lib/member-merge.ts": "merge: attach through the scoped merge grant, redact the audit",
  // #3029 READERS of the booking value.
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-guest-dietary.ts": {
    reason: "booking-admin grant (bookings:view/edit, DB-verified) for R1",
    ...BOOKING,
    side: "read",
  },
  "src/app/api/admin/bookings/[id]/guest-dietary/route.ts": {
    reason: "booking-admin edit grant for R4",
    ...BOOKING,
    side: "read",
  },
  "src/app/api/lodge/guests/[date]/route.ts": {
    reason: "kiosk grant (admin + hut-leader tiers, present guests only) for R2",
    allow: [],
    side: "read",
  },
  [BOOKING_WRITES_MODULE]: {
    reason: "the write half reads the field toggle through the door (#3029)",
    ...BOOKING,
    side: "write",
  },
};

/**
 * Rule 8's list (#3029): the closed set of booking WRITERS that import the write
 * half. Every entry is a `write` entry: rule 8 refuses a grant, reader or
 * loader in any of them, so a booking writer can decide what a row carries but
 * can never read a value back.
 */
const BOOKING_WRITES_IMPORTERS: Readonly<Record<string, CensusEntry>> = {
  "src/app/api/bookings/route.ts": { reason: "W1/W2/W4 seeding read", ...WRITE_SIDE },
  "src/app/api/bookings/[id]/guests/route.ts": { reason: "W10 add guest", ...WRITE_SIDE },
  "src/lib/admin-booking-copy.ts": { reason: "W19 copy re-seeds", ...WRITE_SIDE },
  "src/lib/booking-batch-modification-service.ts": {
    reason: "seeding read with the pre-transaction work (W11/W12/W15)",
    ...WRITE_SIDE,
  },
  "src/lib/booking-create-guests.ts": { reason: "the create-data builder", ...WRITE_SIDE },
  "src/lib/booking-create-types.ts": { reason: "seeding/carry types", ...WRITE_SIDE },
  "src/lib/booking-create.ts": { reason: "W1/W2/W3/W4 resolver", ...WRITE_SIDE },
  "src/lib/booking-exception-approval.ts": {
    reason: "W2 policy-exception approval seeding read",
    ...WRITE_SIDE,
  },
  "src/lib/booking-modify-plan.ts": { reason: "W11/W12 resolver, W15 fill", ...WRITE_SIDE },
  "src/lib/booking-request-quotes.ts": { reason: "W6 held booking", ...WRITE_SIDE },
  "src/lib/booking-request-shared.ts": { reason: "the pipeline create shaper", ...WRITE_SIDE },
  "src/lib/booking-request.ts": { reason: "W7 approval, W13/W14 held party", ...WRITE_SIDE },
  "src/lib/group-booking.ts": { reason: "W2 group join, W5 non-member joiner", ...WRITE_SIDE },
  "src/lib/school-booking-request.ts": { reason: "W8 school, W9 whole-lodge", ...WRITE_SIDE },
  "src/lib/waitlist-cross-lodge.ts": { reason: "W18 cross-lodge offer carries", ...WRITE_SIDE },
  "src/lib/member-guest-consent-service.ts": {
    reason: "S5: a granted consent fills the member's empty row from their profile",
    allow: [],
    side: "write",
  },
};

/** An import of the write half, in the same spellings as the door's. */
const BOOKING_WRITES_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'`](?:@\/lib\/|(?:\.{1,2}\/)+(?:[\w-]+\/)*)member-dietary-booking-writes(?:\.[cm]?[jt]sx?)?["'`]/;

/**
 * Rule 6: path fragments of surfaces the value must never reach. A reach or
 * importer entry matching one of these fails even when it is listed, so
 * widening either list onto an egress surface is refused rather than
 * rubber-stamped.
 */
const EGRESS_SURFACE_PATTERNS: readonly RegExp[] = Object.values(EGRESS_SURFACES);

/** Rule 2's exemption: the only whole-row raw read, and why it is safe. */
const RAW_WILDCARD_EXEMPT: Readonly<Record<string, string>> = {
  "src/lib/diagnostics/tools/database.ts":
    "wraps operator SQL under the SELECT-only diagnostics role, whose Member " +
    "grant is a column allowlist that does not include dietaryRequirements " +
    "(provision-role.ts); PostgreSQL refuses the column (42501)",
};

/**
 * Rule 3's classification: clients that are NOT the application's and so do
 * not carry the omission. Each is a tool that never returns a Member value to
 * a person or a payload.
 */
const CONSTRUCTOR_EXEMPT: Readonly<Record<string, string>> = {
  "prisma/seed.ts": "seeds a fresh database; writes rows, returns none to anyone",
  "prisma/demo-seed.ts": "seeds demo data; writes rows, returns none to anyone",
  "scripts/rehearse-epic-deploy.ts":
    "rehearsal against a scratch database with the OLD generated client; reads " +
    "take:1 per model only to prove the columns resolve, and records counts",
  "e2e/helpers/rate-limit-counter.ts": "E2E harness against the test database",
  "e2e/helpers/setup-state.ts": "E2E harness against the test database",
  "e2e/setup/enable-e2e-modules.ts": "E2E harness against the test database",
  "e2e/setup/relativize-seasons.ts": "E2E harness against the test database",
  "e2e/setup/seed-second-lodge.ts": "E2E harness against the test database",
};

const RAW_SQL_API =
  /\$queryRaw|\$queryRawUnsafe|\$executeRaw|\$executeRawUnsafe|Prisma\.sql|Prisma\.raw/;
const SELECT_OR_OMIT = /["']?\bdietaryRequirements\b["']?\s*:\s*(?:true|false)\b/;
const IDENTIFIER = /\bdietaryRequirements\b/;
/**
 * A whole-row raw read: `SELECT *`, `SELECT*`, `SELECT DISTINCT *`,
 * `SELECT m.*` or `SELECT id, "Member".*`, a bare `TABLE "Member"` statement,
 * or a whole row turned into JSON (`row_to_json(m)`, `to_json(b)(m)`,
 * `json(b)_agg(m)`).
 */
const RAW_WILDCARD = new RegExp(
  [
    String.raw`\bSELECT\s*(?:DISTINCT\s+)?(?:(?:"?[A-Za-z_]\w*"?\s*\.\s*)?\*)`,
    String.raw`\bSELECT\b[^;\`]{0,400}?,\s*(?:"?[A-Za-z_]\w*"?\s*\.\s*)\*`,
    // `TABLE "Member"` as a statement of its own, not `ALTER TABLE "Member"`.
    String.raw`(?:^|[;(\`])\s*TABLE\s+"?Member"?\b`,
    // A whole row (a bare alias) turned into JSON; `jsonb_agg(col ->> 'x')`
    // aggregates an expression, not a row, and is not matched.
    String.raw`\b(?:row_to_json|to_jsonb?|jsonb?_agg)\s*\(\s*"?[A-Za-z_]\w*"?\s*\)`,
  ].join("|"),
  "im",
);
/**
 * An import of the canonical module in any spelling: static, dynamic or
 * `require`, an alias or relative path, an explicit extension, and a quoted or
 * template-literal specifier. `member-dietary-field` is a different module and
 * is not matched.
 */
const DIETARY_MODULE_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'`](?:@\/lib\/|(?:\.{1,2}\/)+(?:[\w-]+\/)*)member-dietary(?:\.[cm]?[jt]sx?)?["'`]/;
/** A grant, reader or merge-attach symbol of the canonical module. */
const DIETARY_DOOR_SYMBOL =
  String.raw`\b(?:grant\w*Dietary\w*|read\w*Dietary\w*|load\w*Dietary\w*|attachMergeDietary\w*)\b`;
/**
 * Passing the door on to files the importer list never saw: a re-export, an
 * exported alias (`export const g = grantSelfDietaryAccess`), an `export
 * default` of one, or an exported wrapper whose body mints a grant.
 */
const DIETARY_PASS_ON = new RegExp(
  [
    String.raw`export\s*\*\s*from\s*["'\`][^"'\`]*member-dietary(?:\.[cm]?[jt]sx?)?["'\`]`,
    String.raw`export\s*\{[^}]*${DIETARY_DOOR_SYMBOL}`,
    String.raw`export\s+(?:const|let|var|default)\b[^;]*?${DIETARY_DOOR_SYMBOL}`,
  ].join("|"),
);
const DIETARY_MINTING_WRAPPER =
  /export\s+(?:async\s+)?function\b[^{]*\{[^}]*?\b(?:grant\w*Dietary\w*|attachMergeDietary\w*)\s*\(/;
/**
 * Where exporting a function that mints a grant is the point rather than a
 * leak. A Next.js route handler or page is an entry point that nothing imports;
 * the merge engine mints its scoped merge grant internally, and its CALLERS are
 * what rule 7 confines.
 */
function mayExportMintingFunction(file: string): boolean {
  return (
    /\/(?:route|page|layout)\.tsx?$/.test(file) ||
    file === MERGE_ENGINE_MODULE ||
    file in MINTING_LOADERS
  );
}

/**
 * Page loaders that mint a grant for the SESSION USER and return rows, never the
 * grant (#3029). Importing one hands a caller nothing it could not get by being
 * that user on that page, so exporting it is not a widening — but the list is
 * closed, so a new one is seen.
 */
const MINTING_LOADERS: Readonly<Record<string, string>> = {
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-guest-dietary.ts":
    "the booking detail page's booking-admin loader (R1)",
};

/**
 * Rule 7: the merge engine mints a scoped merge grant from the actor id it is
 * handed, and its preview returns both members' values in `fieldMerge`. So a
 * file that calls it can reach the value without importing the dietary module
 * or spelling the field. Its callers are confined here, and checked against the
 * egress patterns like every other list.
 */
const MERGE_ENGINE_MODULE = "src/lib/member-merge.ts";
const MERGE_ENGINE_ENTRY = /\b(?:buildMemberMergePreview|executeMemberMerge)\b/;
const MERGE_ENGINE_CALLERS: Readonly<Record<string, string>> = {
  "src/app/api/admin/members/[id]/merge/preview/route.ts":
    "Full Admin merge preview (the engine re-checks Full Admin in the database)",
  "src/app/api/admin/members/[id]/merge/route.ts":
    "Full Admin merge execute (the engine re-checks Full Admin in the database)",
};

type Finding = { rule: string; file: string; detail: string };

/** Every `new …PrismaClient(` call, including aliased and namespaced ones. */
function prismaConstructorStarts(code: string): number[] {
  const names = ["PrismaClient"];
  for (const match of code.matchAll(/\bPrismaClient\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    names.push(match[1]!);
  }
  const alternation = names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    String.raw`\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:${alternation})\s*\(`,
    "g",
  );
  return [...code.matchAll(pattern)].map((match) => match.index! + match[0].length);
}

/** Pure scanner, so the mutation block below can seed it without the tree. */
export function scanDietaryAccessSource(file: string, source: string): Finding[] {
  const code = stripComments(source);
  const findings: Finding[] = [];
  const isApplication = file.startsWith("src/");

  if (
    SELECT_OR_OMIT.test(code) &&
    !COLUMN_OWNERS.has(file) &&
    file !== OMIT_CONSTANT_MODULE
  ) {
    findings.push({
      rule: "select-or-omit",
      file,
      detail: "selects or overrides the omission of dietaryRequirements",
    });
  }

  if (RAW_SQL_API.test(code) && IDENTIFIER.test(code)) {
    findings.push({
      rule: "raw-sql",
      file,
      detail: "issues raw SQL and names dietaryRequirements",
    });
  }

  if (RAW_WILDCARD.test(code) && !(file in RAW_WILDCARD_EXEMPT)) {
    findings.push({
      rule: "raw-wildcard",
      file,
      detail:
        'reads a whole row through SELECT *, alias.*, TABLE "Member" or a JSON row function',
    });
  }

  if (!(file in CONSTRUCTOR_EXEMPT)) {
    for (const start of prismaConstructorStarts(code)) {
      const args = constructorArguments(code, start);
      if (!/\bomit\s*:\s*PRISMA_CLIENT_GLOBAL_OMIT\b/.test(args)) {
        findings.push({
          rule: "constructor",
          file,
          detail: "constructs a PrismaClient without omit: PRISMA_CLIENT_GLOBAL_OMIT",
        });
      }
    }
  }

  if (isApplication && IDENTIFIER.test(code) && !(file in DIETARY_REACH)) {
    findings.push({
      rule: "reach",
      file,
      detail: "names dietaryRequirements but is not in DIETARY_REACH",
    });
  }

  if (
    file !== CANONICAL_MODULE &&
    DIETARY_MODULE_IMPORT.test(code) &&
    !(file in DIETARY_MODULE_IMPORTERS)
  ) {
    findings.push({
      rule: "import",
      file,
      detail: "imports the dietary module but is not in DIETARY_MODULE_IMPORTERS",
    });
  }

  if (
    file !== CANONICAL_MODULE &&
    (DIETARY_PASS_ON.test(code) ||
      (DIETARY_MINTING_WRAPPER.test(code) && !mayExportMintingFunction(file)))
  ) {
    findings.push({
      rule: "reexport",
      file,
      detail:
        "re-exports, aliases or wraps a dietary grant or reader, widening the importer list unseen",
    });
  }

  if (
    file !== MERGE_ENGINE_MODULE &&
    MERGE_ENGINE_ENTRY.test(code) &&
    !(file in MERGE_ENGINE_CALLERS)
  ) {
    findings.push({
      rule: "merge-caller",
      file,
      detail:
        "calls the merge engine, which returns dietary values, but is not in MERGE_ENGINE_CALLERS",
    });
  }

  if (
    file !== BOOKING_WRITES_MODULE &&
    BOOKING_WRITES_IMPORT.test(code) &&
    !(file in BOOKING_WRITES_IMPORTERS)
  ) {
    findings.push({
      rule: "writes-import",
      file,
      detail: "imports the booking write half but is not in BOOKING_WRITES_IMPORTERS",
    });
  }

  const importerEntry = BOOKING_WRITES_IMPORTERS[file] ?? DIETARY_MODULE_IMPORTERS[file];
  if (
    typeof importerEntry === "object" &&
    importerEntry.side === "write" &&
    new RegExp(DIETARY_DOOR_SYMBOL).test(code)
  ) {
    findings.push({
      rule: "write-side-door",
      file,
      detail:
        "is a booking WRITER (write half only) but names a dietary grant, reader or loader",
    });
  }

  if (
    !COLUMN_OWNERS.has(file) &&
    BOOKING_GUEST_WRITE_CALL.test(code) &&
    IDENTIFIER.test(code)
  ) {
    findings.push({
      rule: "writer-names-column",
      file,
      detail:
        "writes BookingGuest rows and names dietaryRequirements; only the dietary boundary writes the column",
    });
  }

  if (file !== BOOKING_WRITES_MODULE) {
    const withoutImports = code.replace(IMPORT_DECLARATION, "");
    for (const match of withoutImports.matchAll(FRAGMENT_BUILDER)) {
      const before = withoutImports.slice(0, match.index);
      const after = withoutImports.slice(match.index! + match[0].length);
      if (!/\.\.\.\s*$/.test(before) || !/^\s*\(/.test(after)) {
        findings.push({
          rule: "fragment-outside-spread",
          file,
          detail: `uses ${match[0]} other than as the operand of a ... data spread, where its plain value could be read`,
        });
      }
    }
    for (const match of code.matchAll(WRITES_NAMED_IMPORT)) {
      if (/\bas\b/.test(match[1] ?? "")) {
        findings.push({
          rule: "writes-import-alias",
          file,
          detail:
            "renames a symbol imported from the booking write half, which would hide it from the spread and seeding rules",
        });
      }
    }
    if (SEEDING_CONSTRUCTION.test(code)) {
      findings.push({
        rule: "seeding-constructor",
        file,
        detail:
          "constructs a dietary seeding value by hand; production seeding comes from resolveBookingGuestDietarySeeding() alone",
      });
    }
  }

  return findings;
}

/**
 * S3: the two fragment builders return the plain value Prisma writes, so they
 * may appear only as the operand of a `...` spread (text-only: it cannot see
 * what that spread goes into), and seeding may only come from the toggle.
 */
const FRAGMENT_BUILDER = /\bbookingGuestDietary(?:Create|Update)Data\b/g;
const IMPORT_DECLARATION = /\bimport\s*(?:type\s*)?\{[^}]*\}\s*from\s*["'`][^"'`]+["'`]\s*;?/g;
// Any appearance of the constructor's NAME outside the write half, not only a
// call: a destructuring rename, a namespace member read or a bracket lookup all
// spell it without a following `(` (#3029 P1). Case-sensitive, so the type
// `BookingGuestDietarySeeding` and `resolveBookingGuestDietarySeeding` are not it.
const SEEDING_CONSTRUCTION =
  /(?<![\w$])bookingGuestDietarySeeding(?![\w$])|\bseedFromProfile\b/;
/**
 * N2: a named import (or re-export) from the write half, capturing its braces.
 * An `as` rename inside them is refused. A namespace import (`import * as W`)
 * is allowed on purpose: `W.bookingGuestDietaryCreateData(` is not a `...`
 * operand and `W.bookingGuestDietarySeeding(` still spells the constructor, so
 * both rules above still see it; a destructuring rename leaves the builder name
 * followed by `:` rather than `(`, which the spread rule refuses too.
 */
const WRITES_NAMED_IMPORT =
  /\b(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'`][^"'`]*member-dietary-booking-writes(?:\.[cm]?[jt]sx?)?["'`]/g;

/** A BookingGuest write call in any spelling a writer uses (`INV-MOD-059`). */
const BOOKING_GUEST_WRITE_CALL =
  /\bbookingGuest\s*\.\s*(?:create|createMany|update|updateMany|upsert)\s*\(/;
/** A NESTED guest create inside a booking create (`guests: { create(Many): ... }`). */
const NESTED_GUEST_CREATE = /\bguests\s*:\s*\{\s*create(?:Many)?\s*:/g;
/** A direct BookingGuest create (`tx.bookingGuest.create(`, createMany, upsert). */
const DIRECT_GUEST_CREATE = /\bbookingGuest\s*\.\s*(?:create|createMany|upsert)\s*\(/g;
/**
 * What a create site hands its builder: the dietary decision, in one of three
 * spellings (a direct create spreads the fragment; a nested one goes through a
 * shared builder whose decision argument is required).
 */
const DIETARY_CREATE_DECISION =
  /\.\.\.\s*bookingGuestDietaryCreateData\s*\(|\b(?:buildGuestCreateData|toPipelineGuestCreateData)\s*\(/g;
const countOf = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

/** The text between a constructor's opening paren and its matching close. */
function constructorArguments(code: string, start: number): string {
  let depth = 1;
  for (let i = start; i < code.length; i += 1) {
    const char = code[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(start, i);
    }
  }
  return code.slice(start);
}

/**
 * The scanned roots. `src/` is the application; `scripts/`, `prisma/` and
 * `e2e/` hold operator CLIs, seeds and harnesses, which are held to every rule
 * except REACH (they may not name the field either way — none do) and whose
 * non-application clients are classified in CONSTRUCTOR_EXEMPT.
 */
const SCANNED_ROOTS = ["src", "scripts", "prisma", "e2e"] as const;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "node_modules" ||
        entry.name === "migrations"
      ) {
        continue;
      }
      files.push(...sourceFiles(full));
    } else if (
      /\.(ts|tsx|mts|cts|mjs|js)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx|mts|mjs|js)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function relative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

let cached: {
  files: string[];
  findings: Finding[];
  reached: string[];
  importers: string[];
  writesImporters: string[];
} | null = null;
function census() {
  if (cached) return cached;
  const files = SCANNED_ROOTS.flatMap((root) =>
    sourceFiles(path.join(REPO_ROOT, root)),
  ).map(relative);
  const findings: Finding[] = [];
  const reached: string[] = [];
  const importers: string[] = [];
  const writesImporters: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    findings.push(...scanDietaryAccessSource(file, source));
    const code = stripComments(source);
    if (file.startsWith("src/") && IDENTIFIER.test(code)) reached.push(file);
    if (file !== CANONICAL_MODULE && DIETARY_MODULE_IMPORT.test(code)) {
      importers.push(file);
    }
    if (file !== BOOKING_WRITES_MODULE && BOOKING_WRITES_IMPORT.test(code)) {
      writesImporters.push(file);
    }
  }
  cached = {
    files,
    findings,
    reached: reached.sort(),
    importers: importers.sort(),
    writesImporters: writesImporters.sort(),
  };
  return cached;
}

function report(findings: Finding[]): string {
  return findings.map((f) => `  ${f.rule}: ${f.file} — ${f.detail}`).join("\n");
}

describe(`member dietary access census (${INVARIANT_ID})`, () => {
  it("walks every scanned root", () => {
    // A walk that found nothing would pass every rule below vacuously.
    const { files } = census();
    expect(files.filter((f) => f.startsWith("src/")).length).toBeGreaterThan(500);
    for (const root of ["scripts/", "prisma/", "e2e/"]) {
      expect(files.some((f) => f.startsWith(root)), root).toBe(true);
    }
    expect(files).toContain(CANONICAL_MODULE);
  });

  it("the client-wide omission names Member and BookingGuest dietaryRequirements", () => {
    expect(PRISMA_CLIENT_GLOBAL_OMIT).toEqual({
      member: { dietaryRequirements: true },
      bookingGuest: { dietaryRequirements: true },
    });
  });

  for (const rule of [
    "select-or-omit",
    "raw-sql",
    "raw-wildcard",
    "constructor",
    "reach",
    "import",
    "reexport",
    "merge-caller",
    "write-side-door",
    "writer-names-column",
    "writes-import",
    "fragment-outside-spread",
    "seeding-constructor",
    "writes-import-alias",
  ] as const) {
    it(`finds no ${rule} violation`, () => {
      const violations = census().findings.filter((f) => f.rule === rule);
      expect(
        violations,
        `${INVARIANT_ID}: dietary/allergy data may be selected only by ${CANONICAL_MODULE}, ` +
          `for a caller holding a grant, from a client that omits it by default.\n` +
          report(violations),
      ).toEqual([]);
    });
  }

  it("every application PrismaClient constructor was actually seen", () => {
    // If this drops, the constructor rule could be passing because the scan no
    // longer sees either client.
    const constructing = census().files.filter(
      (file) =>
        !(file in CONSTRUCTOR_EXEMPT) &&
        prismaConstructorStarts(
          stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8")),
        ).length > 0,
    );
    expect(constructing.sort()).toEqual([
      "src/lib/audit-retention.ts",
      "src/lib/prisma.ts",
    ]);
  });

  it("the constructor exemptions are exact: each still constructs a client", () => {
    const stale = Object.keys(CONSTRUCTOR_EXEMPT).filter(
      (file) =>
        prismaConstructorStarts(
          stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8")),
        ).length === 0,
    );
    expect(stale).toEqual([]);
  });

  it("the reach list is exact: every listed file still names the field", () => {
    const stale = Object.keys(DIETARY_REACH).filter(
      (file) => !census().reached.includes(file),
    );
    expect(
      stale,
      `${INVARIANT_ID}: these DIETARY_REACH entries no longer name dietaryRequirements; remove them so the list matches the tree.`,
    ).toEqual([]);
    expect(census().reached).toEqual(Object.keys(DIETARY_REACH).sort());
  });

  it("the importer list is exact: every listed file still imports the module", () => {
    expect(census().importers).toEqual(Object.keys(DIETARY_MODULE_IMPORTERS).sort());
  });

  it("the write-half importer list is exact, and every entry is a write entry (#3029)", () => {
    expect(census().writesImporters).toEqual(Object.keys(BOOKING_WRITES_IMPORTERS).sort());
    for (const [file, entry] of Object.entries(BOOKING_WRITES_IMPORTERS)) {
      expect(typeof entry === "object" && entry.side, file).toBe("write");
    }
  });

  it("the real-database omission proof stays wired into the CI harness", () => {
    // It self-skips without RUN_CONCURRENCY_RACE_TESTS, so an unwired file
    // would pass everywhere while proving nothing.
    const harness = readFileSync(
      path.join(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./member-dietary-omit.realdb.test";');
  });

  it("the merge-engine caller list is exact: every listed file still calls it", () => {
    const callers = census()
      .files.filter(
        (file) =>
          file !== MERGE_ENGINE_MODULE &&
          MERGE_ENGINE_ENTRY.test(
            stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8")),
          ),
      )
      .sort();
    expect(callers).toEqual(Object.keys(MERGE_ENGINE_CALLERS).sort());
  });

  it("no reach, importer or merge-caller entry is an egress surface it was not allowed onto", () => {
    const egress = [
      ...Object.entries(DIETARY_REACH),
      ...Object.entries(DIETARY_MODULE_IMPORTERS),
      ...Object.entries(BOOKING_WRITES_IMPORTERS),
      ...Object.entries(MERGE_ENGINE_CALLERS),
    ].flatMap(([file, entry]) =>
      unallowedEgress(file, entry).map((family) => `${file} (${family})`),
    );
    expect(
      egress,
      `${INVARIANT_ID}: dietary/allergy data must not reach Xero, analytics, notifications, email, rosters, lodge screens, family views, booking or finance exports, or logs; only a named booking-value entry may sit on the booking or kiosk family.`,
    ).toEqual([]);
    // Every pattern is a family (nothing was dropped when they were named).
    expect(EGRESS_SURFACE_PATTERNS).toHaveLength(9);
  });

  it("an allowance names only the booking or kiosk family, never a provider, message, roster, finance or log surface", () => {
    const allowances = [
      ...Object.values(DIETARY_REACH),
      ...Object.values(DIETARY_MODULE_IMPORTERS),
      ...Object.values(BOOKING_WRITES_IMPORTERS),
    ].flatMap((entry) => allowedFamilies(entry));
    for (const family of allowances) {
      expect(ALLOWABLE_EGRESS_FAMILIES as readonly string[], family).toContain(family);
    }
  });
});

/**
 * The BookingGuest WRITER census (#3029, `INV-MOD-059`). Text over `src/`, same
 * honesty as above: it proves that every create site is on this list and hands
 * its builder a dietary decision, and that the listed never-name writers leave
 * the column alone; the behaviour of each decision is proven in
 * `member-dietary-booking-lifecycle.test.ts`.
 */
const BOOKING_GUEST_CREATE_SITES: Readonly<Record<string, string>> = {
  "src/lib/booking-create.ts": "W1 draft, W2 confirmed, W3 split child, W4 waitlisted",
  "src/lib/group-booking.ts": "W5 non-member group joiner",
  "src/lib/booking-request-quotes.ts": "W6 public/school held booking",
  "src/lib/booking-request.ts": "W7 approval without a hold, W13 held-party rebuild",
  "src/lib/school-booking-request.ts": "W8 school approval, W9 member whole-lodge",
  "src/app/api/bookings/[id]/guests/route.ts": "W10 add a guest",
  "src/lib/booking-modify-plan.ts": "W11 in-progress add, W12 modification add",
};

/**
 * Writers that change a guest row and must NEVER name the column: leaving it
 * alone is how a date move, a removal, a promotion, a rename, a consent answer,
 * a price repair or an arrival preserves the value.
 */
const NEVER_NAME_WRITERS: Readonly<Record<string, string>> = {
  "src/lib/booking-date-modification-service.ts": "date modification",
  "src/lib/booking-guest-removal-service.ts": "guest removal",
  "src/lib/waitlist.ts": "waitlist promotion",
  "src/lib/school-attendee-confirmation.ts": "school attendee rename",
  "src/lib/stored-night-price-repair-store.ts": "night-price repair",
  "src/app/api/lodge/guests/[date]/arrive/route.ts": "lodge arrive",
  "src/app/api/lodge/guests/[date]/depart/route.ts": "lodge depart",
};

describe(`booking-guest dietary writer census (${LIFECYCLE_INVARIANT_ID})`, () => {
  const code = (file: string) =>
    stripComments(readFileSync(path.join(REPO_ROOT, file), "utf8"));

  it("every BookingGuest create site is on the closed list", () => {
    const sites = census()
      .files.filter((file) => file.startsWith("src/") && !COLUMN_OWNERS.has(file))
      .filter((file) => {
        const text = code(file);
        return countOf(text, NESTED_GUEST_CREATE) + countOf(text, DIRECT_GUEST_CREATE) > 0;
      })
      .sort();
    expect(
      sites,
      `${LIFECYCLE_INVARIANT_ID}: a new BookingGuest create site must be listed here and hand its builder a dietary decision.`,
    ).toEqual(Object.keys(BOOKING_GUEST_CREATE_SITES).sort());
  });

  it("every create site hands its builder a dietary decision, one per create, file by file (L2)", () => {
    const mismatched = Object.keys(BOOKING_GUEST_CREATE_SITES).flatMap((file) => {
      const text = code(file);
      const creates = countOf(text, NESTED_GUEST_CREATE) + countOf(text, DIRECT_GUEST_CREATE);
      const decisions = countOf(text, DIETARY_CREATE_DECISION);
      return creates === decisions ? [] : [`${file}: ${creates} create(s), ${decisions} decision(s)`];
    });
    expect(mismatched, `${LIFECYCLE_INVARIANT_ID}: a guest create without its dietary decision`).toEqual([]);
  });

  it("both shared builders spread the module's create fragment", () => {
    for (const file of ["src/lib/booking-create-guests.ts", "src/lib/booking-request-shared.ts"]) {
      expect(code(file), `${LIFECYCLE_INVARIANT_ID}: ${file}`).toMatch(
        /\.\.\.bookingGuestDietaryCreateData\(/,
      );
    }
  });

  it("no site creates guests in bulk, where a per-row decision cannot ride", () => {
    const bulk = census()
      .files.filter((file) => file.startsWith("src/"))
      .filter((file) => /\bbookingGuest\s*\.\s*createMany\s*\(/.test(code(file)));
    expect(bulk, LIFECYCLE_INVARIANT_ID).toEqual([]);
  });

  it("the never-name writers neither spell the column nor import the module", () => {
    const offenders = Object.keys(NEVER_NAME_WRITERS).filter((file) => {
      const text = code(file);
      return IDENTIFIER.test(text) || DIETARY_MODULE_IMPORT.test(text);
    });
    expect(offenders, `${LIFECYCLE_INVARIANT_ID}: these writers must leave the value alone`).toEqual([]);
    // And each still writes guest rows, so the list cannot go stale unnoticed.
    const stale = Object.keys(NEVER_NAME_WRITERS).filter(
      (file) => !BOOKING_GUEST_WRITE_CALL.test(code(file)) && !/bookingGuest\s*\.\s*delete/.test(code(file)),
    );
    expect(stale).toEqual([]);
  });

  it("account anonymisation clears the guest rows' value in the same update (W16)", () => {
    const route = code("src/app/api/admin/deletion-requests/[id]/route.ts");
    const block = route.slice(route.indexOf("tx.bookingGuest.updateMany("));
    const call = block.slice(0, block.indexOf("});") + 3);
    expect(call, `${INVARIANT_ID}: W16`).toMatch(/memberId: null,[\s\S]*\.\.\.DIETARY_ERASURE_PATCH/);
  });
});

describe(`member dietary access census scanner (${INVARIANT_ID}) — mutation proofs`, () => {
  const file = "src/lib/some-new-reader.ts";
  const rulesOf = (source: string, at = file) =>
    scanDietaryAccessSource(at, source).map((f) => f.rule);

  it("reports a select outside the canonical module", () => {
    expect(
      rulesOf(`await prisma.member.findMany({ select: { id: true, dietaryRequirements: true } });`),
    ).toContain("select-or-omit");
  });

  it("reports a local omit override, quoted key included", () => {
    expect(
      rulesOf(`await prisma.member.findMany({ omit: { "dietaryRequirements": false } });`),
    ).toContain("select-or-omit");
  });

  it("allows the select inside the canonical module", () => {
    const rules = rulesOf(
      `await db.member.findUnique({ where: { id }, select: { dietaryRequirements: true } });`,
      CANONICAL_MODULE,
    );
    expect(rules).not.toContain("select-or-omit");
    expect(rules).not.toContain("reach");
  });

  it("reports a raw-SQL read of the column", () => {
    expect(
      rulesOf('await prisma.$queryRaw`SELECT "dietaryRequirements" FROM "Member"`;'),
    ).toContain("raw-sql");
  });

  it("reports every whole-row raw read spelling", () => {
    for (const sql of [
      'SELECT * FROM "Member" WHERE id = $1',
      'SELECT* FROM "Member"',
      'SELECT DISTINCT * FROM "Member"',
      'SELECT m.* FROM "Member" m',
      'SELECT m.id, "Member".* FROM "Member"',
      'SELECT id, m.* FROM "Member" m',
      'TABLE "Member"',
      'SELECT row_to_json(m) FROM "Member" m',
      'SELECT to_jsonb(m) FROM "Member" m',
      'SELECT json_agg(m) FROM "Member" m',
      'SELECT jsonb_agg(m) FROM "Member" m',
    ]) {
      expect(rulesOf(`await prisma.$queryRawUnsafe(\`${sql}\`);`), sql).toContain(
        "raw-wildcard",
      );
    }
    for (const sql of [
      'SELECT count(*) FROM "Member"',
      'ALTER TABLE "Member" ADD COLUMN "x" TEXT',
      "SELECT jsonb_agg(row_value ->> 'guestRef') FROM t",
    ]) {
      expect(rulesOf(`await prisma.$queryRawUnsafe(\`${sql}\`);`), sql).not.toContain(
        "raw-wildcard",
      );
    }
  });

  it("reports a PrismaClient constructed without the omission, however it is spelled", () => {
    for (const source of [
      `const client = new PrismaClient({ adapter: a() });`,
      `import * as P from "@prisma/client";\nconst client = new P.PrismaClient({ adapter: a() });`,
      `import { PrismaClient as Db } from "@prisma/client";\nconst client = new Db({ adapter: a() });`,
    ]) {
      expect(rulesOf(source), source).toContain("constructor");
    }
    expect(
      rulesOf(`const client = new PrismaClient({ adapter: a(), omit: PRISMA_CLIENT_GLOBAL_OMIT });`),
    ).not.toContain("constructor");
  });

  it("reports an unlisted file that names the field, and ignores a comment", () => {
    expect(rulesOf(`const x = row.dietaryRequirements;`)).toContain("reach");
    expect(rulesOf(`// dietaryRequirements is discussed here only\nconst y = 1;`)).toEqual([]);
  });

  it("reports an unlisted file that imports the module without naming the field", () => {
    const source = [
      `import { grantMemberMergeDietaryAccess, readMemberDietaryRequirementsByIds } from "@/lib/member-dietary";`,
      `const grant = await grantMemberMergeDietaryAccess(db, scope);`,
      `const values = await readMemberDietaryRequirementsByIds(grant!, ids);`,
    ].join("\n");
    expect(rulesOf(source)).toContain("import");
    expect(rulesOf(`const m = await import("../lib/member-dietary");`)).toContain("import");
    expect(
      rulesOf(`import { x } from "@/lib/member-dietary-field";`),
    ).not.toContain("import");
  });

  it("reports an import in every specifier spelling", () => {
    for (const source of [
      `import { x } from "@/lib/member-dietary.js";`,
      `import { x } from "../lib/member-dietary.ts";`,
      "const m = await import(`@/lib/member-dietary`);",
      `const m = require("./member-dietary");`,
      `export { x } from"@/lib/member-dietary";`,
    ]) {
      expect(rulesOf(source), source).toContain("import");
    }
  });

  it("reports a re-export, an exported alias, an export default and a minting wrapper", () => {
    for (const source of [
      `export { readMemberDietaryRequirementsByIds } from "@/lib/member-dietary";`,
      `export * from "@/lib/member-dietary";`,
      `export const g = grantSelfDietaryAccess;`,
      `export let r = readMemberDietaryRequirementsByIds;`,
      `export default grantMembershipAdminDietaryAccess;`,
      `export async function widen(db, a, m, l) { return grantMemberMergeDietaryAccess(db, { actorMemberId: a, masterId: m, loserId: l }); }`,
    ]) {
      expect(rulesOf(source), source).toContain("reexport");
    }
    // A route handler that mints a grant for its own request is an entry point.
    expect(
      rulesOf(
        `export async function GET() { const g = await grantMembershipAdminDietaryAccess(guard, "view"); }`,
        "src/app/api/some/route.ts",
      ),
    ).not.toContain("reexport");
  });

  it("reports an unlisted caller of the merge engine", () => {
    const source = [
      `import { buildMemberMergePreview } from "@/lib/member-merge";`,
      `const p = await buildMemberMergePreview({ masterId, loserId, actorMemberId });`,
      `return p.fieldMerge;`,
    ].join("\n");
    expect(rulesOf(source)).toContain("merge-caller");
    expect(
      rulesOf(`await executeMemberMerge({})`, "src/app/api/admin/members/[id]/merge/route.ts"),
    ).not.toContain("merge-caller");
  });

  it("does not mistake the settings toggle for the field", () => {
    expect(rulesOf(`const on = flags.showDietaryRequirements;`)).toEqual([]);
  });

  it("reports a booking writer that reaches for a grant or reader (#3029)", () => {
    const writer = "src/lib/booking-create.ts";
    expect(
      rulesOf(
        `import { resolveBookingGuestDietary } from "@/lib/member-dietary-booking-writes";\nconst w = await resolveBookingGuestDietary(tx, s, g);`,
        writer,
      ),
    ).not.toContain("write-side-door");
    expect(
      rulesOf(
        `import { readKioskGuestDietaryRequirements } from "@/lib/member-dietary";\nawait readKioskGuestDietaryRequirements(g, ids);`,
        writer,
      ),
    ).toContain("write-side-door");
  });

  it("reports an unlisted importer of the booking write half (#3029)", () => {
    expect(
      rulesOf(`import { resolveBookingGuestDietary } from "@/lib/member-dietary-booking-writes";`),
    ).toContain("writes-import");
    expect(
      rulesOf(
        `import { resolveBookingGuestDietary } from "@/lib/member-dietary-booking-writes";`,
        "src/lib/booking-create.ts",
      ),
    ).not.toContain("writes-import");
  });

  it("reports a fragment builder used other than as a spread operand (S3)", () => {
    const writer = "src/lib/booking-create.ts";
    expect(rulesOf(`const d = { ...bookingGuestDietaryCreateData(w) };`, writer)).not.toContain(
      "fragment-outside-spread",
    );
    for (const source of [
      `const leaked = bookingGuestDietaryCreateData(w);`,
      `log(bookingGuestDietaryUpdateData(u).dietaryRequirements);`,
      `const f = bookingGuestDietaryCreateData;`,
    ]) {
      expect(rulesOf(source, writer), source).toContain("fragment-outside-spread");
    }
    expect(
      rulesOf(`import { bookingGuestDietaryCreateData } from "@/lib/member-dietary-booking-writes";`, writer),
    ).not.toContain("fragment-outside-spread");
  });

  it("reports a renamed import from the write half, and sees through a namespace import (N2)", () => {
    const writer = "src/lib/booking-create.ts";
    for (const source of [
      `import { bookingGuestDietaryCreateData as b } from "@/lib/member-dietary-booking-writes";\nconst v = b(w);`,
      `import { bookingGuestDietarySeeding as s } from "@/lib/member-dietary-booking-writes";\nconst x = s(true);`,
      `import {\n  resolveBookingGuestDietary,\n  bookingGuestDietaryUpdateData as u,\n} from "@/lib/member-dietary-booking-writes";`,
    ]) {
      expect(rulesOf(source, writer), source).toContain("writes-import-alias");
    }
    expect(
      rulesOf(`import * as W from "@/lib/member-dietary-booking-writes";\nconst v = W.bookingGuestDietaryCreateData(w);`, writer),
    ).toContain("fragment-outside-spread");
    expect(
      rulesOf(`import * as W from "@/lib/member-dietary-booking-writes";\nconst x = W.bookingGuestDietarySeeding(true);`, writer),
    ).toContain("seeding-constructor");
    expect(
      rulesOf(`const { bookingGuestDietaryCreateData: b } = await import("@/lib/member-dietary-booking-writes");`, writer),
    ).toContain("fragment-outside-spread");
    expect(
      rulesOf(`import { type BookingGuestDietarySeeding, resolveBookingGuestDietary } from "@/lib/member-dietary-booking-writes";`, writer),
    ).not.toContain("writes-import-alias");
  });

  it("reports hand-made seeding outside the write half (S3)", () => {
    for (const source of [
      `const s = bookingGuestDietarySeeding(true);`,
      `const s = { seedFromProfile: true } as never;`,
      // P1: the name without a following call, which a call-only rule missed.
      `const { bookingGuestDietarySeeding: s } = await import("@/lib/member-dietary-booking-writes");\ns(true);`,
      `import * as W from "@/lib/member-dietary-booking-writes";\nconst s = W.bookingGuestDietarySeeding;\ns(true);`,
      `import * as W from "@/lib/member-dietary-booking-writes";\nW["bookingGuestDietarySeeding"](true);`,
    ]) {
      expect(rulesOf(source, "src/lib/booking-create.ts"), source).toContain("seeding-constructor");
    }
    // The type and the toggle-reading resolver share a stem but are not it.
    for (const source of [
      `import { type BookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";`,
      `const seeding = await resolveBookingGuestDietarySeeding();`,
    ]) {
      expect(rulesOf(source, "src/lib/booking-create.ts"), source).not.toContain("seeding-constructor");
    }
  });

  it("reports a file that writes BookingGuest rows naming the column (#3029)", () => {
    expect(
      rulesOf(`await tx.bookingGuest.update({ where: { id }, data: { dietaryRequirements: v } });`),
    ).toContain("writer-names-column");
    expect(
      rulesOf(`await tx.bookingGuest.updateMany({ where: { id }, data: { ...DIETARY_ERASURE_PATCH } });`),
    ).not.toContain("writer-names-column");
  });

  it("refuses an egress family the entry was not allowed onto (#3029)", () => {
    expect(unallowedEgress("src/lib/booking-xero-sync.ts", { reason: "x", allow: ["booking"] })).toEqual([
      "xero",
    ]);
    expect(unallowedEgress("src/app/(lodge)/lodge/kiosk/page.tsx", "stage 1 entry")).toEqual(["kiosk"]);
    expect(unallowedEgress("src/lib/lodge-roster.ts", { reason: "x", allow: ["kiosk"] })).toEqual([
      "lodge-screen",
    ]);
  });
});
