import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PLACEHOLDER_CONTACT_EMAIL_DOMAINS } from "@/lib/placeholder-contact-email";
import { XERO_SANDBOX_CONTACT_EMAIL_DOMAIN } from "@/lib/xero-sandbox-contact-email";

/**
 * INV-CONFIG-005: no Xero contact write can put a member's real email address on
 * a contact without asking which installation this is (ENV-SAFETY 3, #3036;
 * epic #2986).
 *
 * WHAT THIS ADDS THAT THE TYPE SYSTEM DOES NOT. The primary guarantee is a type:
 * the two contact-payload builders in `xero-contacts.ts` take an
 * `XeroContactEmailPolicy`, which only `xero-contact-containment.ts` can mint,
 * and it mints one only after reading the canonical environment role. So an
 * existing builder cannot be called without the question being asked. That is
 * stronger than any census, because it is not a list of the writers that exist
 * today.
 *
 * It has three holes, and this file closes all three:
 *
 * 1. **A brand-new `createContacts` / `updateContact` call**, in a module that
 *    builds its own payload and never touches the two existing builders. No type
 *    stands in its way.
 * 2. **A second `emailAddress:` assignment inside `xero-contacts.ts`** that
 *    forgets the policy — the file already holds two, so a third is an ordinary
 *    edit.
 * 3. **A cast.** `{} as unknown as XeroContactEmailPolicy` type-checks. The
 *    module refuses a forged token at runtime, so the cast fails closed rather
 *    than working — but a source census catches it in review instead of in
 *    production.
 *
 * `test:related` CANNOT select this file: it reads the repository from disk with
 * `fs`, so it has no import edge to the files it scans. Run it explicitly, and
 * expect CI to be the backstop (`docs/TESTING.md`).
 *
 * EVERY CASE BELOW ASSERTS THAT THE REGION IT EXTRACTED CONTAINS THE THING IT
 * CLAIMS TO JUDGE. Five guards in this epic shipped vacuous — a
 * `toContain("PRODUCTION")` that matched `"NON-PRODUCTION"`, ordering assertions
 * a mutant sailed through, a glob test carrying its own copy of the regex, a
 * body slice that landed on a multi-line return type, and a requirement whose
 * mutant passed 218 of 218 tests — and every one was found by a mutation probe
 * rather than by reading. This one assumes it is the sixth.
 */

const SCAN_ROOTS = ["src", "scripts", "prisma", "e2e"].map((root) =>
  path.resolve(process.cwd(), root),
);
const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);

const CONTACTS_MODULE = "src/lib/xero-contacts.ts";
const CONTAINMENT_MODULE = "src/lib/xero-contact-containment.ts";
/*
  The proof half, split out of the module above when it outgrew the file-size
  budget: the durable record, its freshness bound, the provider read-back and
  the refusal. It is the module that WRITES a contact, so it is the one named in
  the writer census below; the policy module holds the token and mints it.
*/
const CONTAINMENT_PROOF_MODULE = "src/lib/xero-contact-containment-proof.ts";
const SANDBOX_MODULE = "src/lib/xero-sandbox-contact-email.ts";

/**
 * The other two modules that write a Xero contact, and what makes them safe.
 *
 * Neither sends an email address at all: the bulk sync repairs a reversed
 * first/last name (`contactID` + the three name fields) and the cancellation
 * path archives a contact (`contactID` + `contactStatus`). They are listed by
 * name AND checked for the absence of `emailAddress`, so one of them growing an
 * address field fails this file rather than silently joining the writers.
 */
const NO_EMAIL_CONTACT_WRITERS = [
  "src/lib/membership-cancellation-xero.ts",
  "src/lib/xero-bulk-contact-sync.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    // Test helper: walks fixed repository roots; `entry` comes from readdir.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(full))) out.push(full);
  }
  return out;
}

function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

const ALL_FILES = SCAN_ROOTS.flatMap((root) => walk(root));

/**
 * Production files only.
 *
 * A test legitimately names `updateContact` — it mocks one, or asserts on the
 * payload sent to one — and this file names every pattern it searches for, so
 * without this it would find itself. The guarantee being enforced is about
 * shipped code; a test that talks to a `vi.fn()` reaches no provider.
 */
const PRODUCTION_FILES = ALL_FILES.filter(
  (file) =>
    !file.split(path.sep).includes("__tests__") &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
);

function filesMatching(pattern: RegExp): string[] {
  return PRODUCTION_FILES.filter((file) =>
    pattern.test(readFileSync(file, "utf8")),
  )
    .map(repoRelative)
    .sort();
}

/** Line comments and block comments removed, so a comment cannot satisfy a case. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function readModule(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("Xero contact containment census (INV-CONFIG-005)", () => {
  it("scans a real tree, so nothing below is an empty-list tautology", () => {
    expect(ALL_FILES.length).toBeGreaterThan(1000);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(1000);
    expect(PRODUCTION_FILES.map(repoRelative)).toContain(CONTACTS_MODULE);
    expect(PRODUCTION_FILES.map(repoRelative)).toContain(CONTAINMENT_MODULE);
    expect(PRODUCTION_FILES.map(repoRelative)).toContain(CONTAINMENT_PROOF_MODULE);
    // The test filter really does remove tests, and really does keep production
    // files — a filter that removed everything would make every list below
    // trivially empty.
    expect(PRODUCTION_FILES.length).toBeLessThan(ALL_FILES.length);
    expect(PRODUCTION_FILES.map(repoRelative)).not.toContain(
      "src/lib/__tests__/xero-contact-containment-census.test.ts",
    );
  });

  it("writes a Xero contact from exactly three modules", () => {
    /*
      Bare method names on ANY receiver, the widening #3035's review measured as
      necessary: `const api = xero.accountingApi; api.updateContact(...)`,
      `const { updateContact } = xero.accountingApi` and
      `xero.accountingApi["updateContact"](...)` all defeat a pattern anchored on
      `accountingApi.`, and aliasing a long provider accessor is exactly the kind
      of edit nobody thinks twice about.
    */
    const writers = filesMatching(
      /\.(?:createContacts|updateContact|updateOrCreateContacts)\s*\(|["'](?:createContacts|updateContact|updateOrCreateContacts)["']\s*\]\s*\(/,
    );
    expect(
      writers,
      "A Xero contact may only be written from the contact layer, the containment " +
        "proof module, or the two writers that carry no email address at all. A new " +
        "call site here would be a contact write that never asked which " +
        "installation this is, and on a copy it would put a member's real " +
        "address back on the contact for Xero to email invoice reminders to " +
        "(INV-CONFIG-005).",
    ).toEqual(
      [
        CONTAINMENT_PROOF_MODULE,
        CONTACTS_MODULE,
        ...NO_EMAIL_CONTACT_WRITERS,
      ].sort(),
    );
  });

  it("keeps the two no-email writers from COMPOSING an email address", () => {
    /*
      Not "the word never appears": `xero-bulk-contact-sync.ts` legitimately
      READS `cachedContact.emailAddress` to compare a member against what Xero
      already holds, and banning the token outright would be a guard that fails
      on a correct file. What must never happen is COMPOSING a value — an address
      built from a member row, a literal, a helper call — because that is the
      shape that travels to the provider. So every `emailAddress:` assignment in
      these files has to be a straight copy of a property read.
    */
    const COPIED_FROM_A_READ = /^\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\.emailAddress\b/;
    let inspected = 0;
    for (const file of NO_EMAIL_CONTACT_WRITERS) {
      const source = withoutComments(readModule(file));
      // Anti-vacuity: the file really is a contact writer, or this loop is
      // asserting something about a file that does nothing.
      expect(source, `${file} must still write a Xero contact`).toMatch(
        /\.(?:createContacts|updateContact|updateOrCreateContacts)\s*\(/,
      );
      for (const [, value] of source.matchAll(/emailAddress:\s*([^\n]*)/g)) {
        inspected += 1;
        expect(
          value,
          `${file} is listed as a contact writer that carries NO email address ` +
            "to Xero. This assignment composes one, so either it must consume " +
            "the containment policy like every other email-carrying writer, or " +
            "the file must stop sending an address (INV-CONFIG-005).",
        ).toMatch(COPIED_FROM_A_READ);
      }
    }
    /*
      And the loop above really inspected something. Measured on the tree this
      shipped with: `xero-bulk-contact-sync.ts` holds two such assignments (both
      feeding `getMemberXeroContactLinkMismatch`, a purely local comparison) and
      `membership-cancellation-xero.ts` holds none. A pattern that stopped
      matching would otherwise pass by finding nothing at all — the exact vacuity
      this epic shipped five times.
    */
    expect(
      inspected,
      "the assignment scan found nothing, so it judged nothing",
    ).toBe(2);
  });

  it("puts an email address into a Xero contact payload only through the policy", () => {
    const source = withoutComments(readModule(CONTACTS_MODULE));
    const assignments = [...source.matchAll(/emailAddress:\s*([^\n]*)/g)];
    // Anti-vacuity in BOTH directions: the file really does hold the two
    // assignments this case is about (the create payload and the update
    // payload), so a pattern that stopped matching cannot pass by finding
    // nothing.
    expect(
      assignments.length,
      `${CONTACTS_MODULE} must still build the two contact payloads that carry ` +
        "an email address",
    ).toBe(2);
    for (const [, value] of assignments) {
      expect(
        value,
        "Every email address written into a Xero contact payload must go " +
          "through applyXeroContactEmailPolicy, which is the identity function " +
          "on the club's live site and the containment transform on a copy " +
          "(INV-CONFIG-005).",
      ).toContain("applyXeroContactEmailPolicy(");
    }
  });

  it("resolves the policy in every function that builds a contact payload", () => {
    const source = withoutComments(readModule(CONTACTS_MODULE));
    for (const fn of [
      "export async function findOrCreateXeroContact(",
      "export async function createXeroContactForMember(",
      "export async function updateXeroContact(",
    ]) {
      const start = source.indexOf(fn);
      expect(start, `${fn} must still exist in ${CONTACTS_MODULE}`).toBeGreaterThan(-1);
      const rest = source.slice(start);
      const end = rest.indexOf("\n}\n");
      expect(end, `${fn} must have a closing brace`).toBeGreaterThan(0);
      const body = rest.slice(0, end);
      /*
        The region really is a function BODY and not a multi-line return type —
        the exact vacuity a probe found in this epic. A body reaches its own
        opening brace and then several hundred characters of statements.
      */
      expect(body.length, `${fn}'s body must be bounded, not empty`).toBeGreaterThan(
        400,
      );
      expect(
        body,
        `${fn} must ask which installation this is before it writes a contact`,
      ).toContain("resolveXeroContactEmailPolicy()");
    }
  });

  it("stamps the policy witness only where the real role is read", () => {
    const policy = readModule(CONTAINMENT_MODULE);
    // Keyed on the assignment, not the property name: the `MintedXeroContactEmailPolicy`
    // TYPE names the property too and is a type, not a stamp.
    const writers = [
      ...policy.matchAll(/\[XERO_CONTACT_POLICY_WITNESS\]:\s*mode/g),
    ];
    expect(
      writers.length,
      "the policy witness must be stamped in exactly the one mint helper",
    ).toBe(1);

    expect(policy).toContain("function mintXeroContactEmailPolicy(");
    expect(
      policy,
      "mintXeroContactEmailPolicy must stay module-private: exporting it hands " +
        "out the token",
    ).not.toContain("export function mintXeroContactEmailPolicy");

    /*
      And it is CALLED only inside `resolveXeroContactEmailPolicy`, which reads
      the role from its canonical resolver rather than taking it as an argument.
      Bounded to that function's body, because an unbounded search would be
      satisfied by a call from the pure function — which is the exact defect
      #3035's review found in the delivery policy.
    */
    const start = policy.indexOf(
      "export async function resolveXeroContactEmailPolicy(",
    );
    expect(start, "resolveXeroContactEmailPolicy must still be defined").toBeGreaterThan(
      -1,
    );
    const rest = policy.slice(start);
    const end = rest.indexOf("\n}\n");
    expect(end).toBeGreaterThan(0);
    const body = rest.slice(0, end);
    expect(body.length, "its body must be bounded, not empty").toBeGreaterThan(200);
    expect(body).toContain("resolveEnvironmentRole()");
    expect(body).toContain("mintXeroContactEmailPolicy(");
    // Once, and only from there. The lookbehind excludes the helper's own
    // declaration, which is also spelled `name(` before its parameter list.
    expect(
      [
        ...policy.matchAll(
          /(?<!function )mintXeroContactEmailPolicy\(/g,
        ),
      ].length,
      "mintXeroContactEmailPolicy must be called exactly once, inside resolveXeroContactEmailPolicy",
    ).toBe(1);

    // The pure decision function must not name the mint at all.
    const pureStart = policy.indexOf(
      "export function decideXeroContactEmailPolicy(",
    );
    expect(pureStart).toBeGreaterThan(-1);
    const pureRest = policy.slice(pureStart);
    const pureBody = pureRest.slice(0, pureRest.indexOf("\n}\n"));
    expect(pureBody.length, "its body must be bounded").toBeGreaterThan(100);
    expect(pureBody).toContain('role === "PRODUCTION"');
    expect(
      pureBody,
      "decideXeroContactEmailPolicy takes caller-supplied input, so it must " +
        "mint nothing (INV-CONFIG-005)",
    ).not.toContain("mintXeroContactEmailPolicy");
  });

  it("mints or casts a contact-email policy in exactly one module", () => {
    const casts = filesMatching(
      /\bas\s+(?:unknown\s+as\s+)?XeroContactEmailPolicy\b|<XeroContactEmailPolicy>/,
    );
    expect(
      casts,
      `An XeroContactEmailPolicy may only be produced inside ${CONTAINMENT_MODULE}, ` +
        "and only after the canonical environment role has been read. Casting " +
        "one elsewhere forges the answer to \"which installation is this?\" — " +
        "the module refuses a forged token at runtime, so such a cast throws " +
        "rather than putting a member's address on a copy's Xero contact, but " +
        "it must not reach review at all (INV-CONFIG-005).",
    ).toEqual([CONTAINMENT_MODULE]);
  });

  it("reads the environment ROLE for containment, never the delivery policy", () => {
    /*
      THE ONE SUBSTITUTION THAT WOULD SILENTLY BREAK THIS. #3035's
      `resolveDeliveryPolicy` carries a capture-transport carve-out: a confirmed
      copy with a declared local capture mailbox is ALLOWED to transmit, because
      a capture catches everything this application sends. A capture catches
      nothing XERO sends — Xero emails an invoice from its own servers to the
      address on the contact — so a copy needs containment whatever its transport
      is. Reaching for the delivery policy here would exempt exactly the
      installations the browser suite runs on.
    */
    const containment = withoutComments(readModule(CONTAINMENT_MODULE));
    expect(
      containment,
      "the containment module must read the canonical environment role",
    ).toContain("resolveEnvironmentRole");
    expect(
      containment,
      "Containment must NOT consume #3035's delivery policy: its capture-mailbox " +
        "carve-out is valid for mail this application sends and invalid for mail " +
        "Xero sends, so a copy with a capture declared would stop containing " +
        "(INV-CONFIG-005).",
    ).not.toMatch(/environment-delivery-policy|resolveDeliveryPolicy/);
  });

  it("keeps the contained domain out of the placeholder domains, at source", () => {
    // The behavioural half of this lives in `xero-sandbox-contact-email.test.ts`.
    // This half is the source-level version: the placeholder module must not name
    // the contained domain at all, so the two lists cannot be merged "for
    // tidiness" by somebody who has not read why they are separate.
    const placeholders = readModule("src/lib/placeholder-contact-email.ts");
    expect(
      placeholders,
      "The contained Xero domain must never join PLACEHOLDER_CONTACT_EMAIL_DOMAINS: " +
        "that predicate means \"this person cannot be reached\" across the mailer, " +
        "the reminder crons, email inheritance and three Xero modules, and a " +
        "contained member CAN be reached on the live site. Adding it would make " +
        "a copy stop behaving like production (INV-CONFIG-005).",
    ).not.toContain(XERO_SANDBOX_CONTACT_EMAIL_DOMAIN);
    // Anti-vacuity: that file really is the home of the placeholder domains.
    for (const domain of PLACEHOLDER_CONTACT_EMAIL_DOMAINS) {
      expect(placeholders).toContain(domain);
    }
  });

  it("spells the contained domain in exactly one module", () => {
    /*
      A SUBSTRING MATCH, not a regular expression. The previous version built one
      by escaping `.` — which is correct for today's constant and incomplete in
      general (CodeQL: js/incomplete-multi-character-sanitization), because it
      leaves `\\` and every other metacharacter alone. The safety of the pattern
      was a property of the constant rather than of the code, and the constant is
      not this test's to guarantee. There is nothing a regex buys here: the
      question is "does this file contain this literal string".
    */
    const spellings = PRODUCTION_FILES.filter((file) =>
      readFileSync(file, "utf8").includes(XERO_SANDBOX_CONTACT_EMAIL_DOMAIN),
    )
      .map(repoRelative)
      .sort()
      .filter((file) => !file.includes("__tests__"));
    expect(
      spellings,
      "The contained domain is a constant, exported from " +
        `${SANDBOX_MODULE}. A second literal copy is how the predicate and the ` +
        "builder come to disagree about what counts as contained " +
        "(INV-CONFIG-005).",
    ).toEqual([SANDBOX_MODULE]);
  });

  it("never writes a contained address onto a Member row", () => {
    /*
      The inbound direction, which is the other way this can go wrong. Two
      admin paths create a `Member` from a Xero contact's stored address, and on
      a copy that address is contained — a hash on a reserved domain. A member
      created from one would read as REACHABLE, because
      `isPlaceholderContactEmail` deliberately says nothing about this domain,
      while being able to receive nothing at all.
    */
    const importers = [
      "src/app/api/admin/xero/import-member-contact/route.ts",
      "src/lib/xero-member-import.ts",
    ];
    for (const file of importers) {
      const source = withoutComments(readModule(file));
      // Anti-vacuity: the file really does create a Member from a contact.
      expect(source, `${file} must still create a member`).toMatch(
        /member\.create\(|\.member\.create\(/,
      );
      expect(source).toMatch(/emailAddress/);
      expect(
        source,
        `${file} creates a Member from a Xero contact's stored address, so it ` +
          "must refuse a contained one — otherwise a copy mints members who " +
          "look reachable and can receive nothing (INV-CONFIG-005).",
      ).toContain("isXeroSandboxContactEmail(");
    }
  });

  /**
   * The two operator surfaces must not promise behaviour that has not landed,
   * and must not claim behaviour that is not what happens.
   *
   * A SOURCE census rather than a React harness, following the precedent
   * `email-delivery-boundary-census.test.ts` set for the same two files: the
   * panel has no test harness at all and inventing one to assert a sentence is
   * the worse trade.
   *
   * TWO PROPERTIES, both of which #3034 deliberately left for this change.
   *
   * 1. #3034 shipped forward-looking hedges — "Once the rest of this work lands",
   *    "land with the rest of this work" — because at the time the role recorded
   *    and reported and nothing acted on it. Both halves have now landed, so a
   *    surviving hedge would be telling an operator that a copy might still email
   *    the club's members, which is the opposite of the mistake #3034 was
   *    avoiding and just as misleading.
   * 2. Neither surface may say a copy stops WRITING to the club's Xero. It does
   *    not: it goes on raising invoices and credit notes, deliberately, so
   *    settlement behaviour stays testable, and if it is pointed at the real
   *    organisation it rewrites real contact records. That sentence was the
   *    obvious replacement for the hedge and it would have been false.
   */
  it("keeps the environment-safety copy free of unlanded promises and false comfort", () => {
    /*
      Each surface is paired with a string that proves the file really is the
      one being judged. A census that reads the wrong path, or a path that has
      been renamed, must fail rather than pass over an empty string.
    */
    const SURFACES: Array<[string, string]> = [
      [
        "src/components/admin/environment-safety-panel.tsx",
        "APP_ENVIRONMENT_ROLE",
      ],
      [
        "src/components/admin/environment-xero-containment.tsx",
        "The club&apos;s Xero contacts",
      ],
      ["src/app/(admin)/admin/environment/page.tsx", "Environment Safety"],
    ];
    const HEDGES = [
      "Once the rest of this work lands",
      "land with the rest of this work",
      "do not treat a copy as safe to run against real data yet",
    ];
    const FALSE_COMFORT = [
      "stops writing to the club's real Xero",
      "out of the club's real accounting",
      /*
        The third false claim, and the one this issue's own first draft made on
        seven surfaces: that an undeclared installation reaches Xero not at all.
        Writes are refused; reads are not, and are not meant to be. A surface
        saying "nothing reaches Xero" tells the operator of an undeclared LIVE
        site that their Xero connection is broken when it is working perfectly.
      */
      "nothing reaches Xero",
      "nothing is reaching Xero",
    ];
    for (const [file, proof] of SURFACES) {
      const source = readModule(file);
      // Anti-vacuity: the file really is one of the surfaces, and really does
      // carry operator copy about a copy of the club's site.
      expect(source.length, `${file} must exist and be non-trivial`).toBeGreaterThan(
        1000,
      );
      expect(source, `${file} must still be the surface it names`).toContain(proof);
      for (const hedge of HEDGES) {
        expect(
          source,
          `${file} still promises "${hedge}". #3035 and #3036 have landed, so ` +
            "that hedge now tells an operator a copy might still email real " +
            "members (INV-CONFIG-004, INV-CONFIG-005).",
        ).not.toContain(hedge);
      }
      for (const claim of FALSE_COMFORT) {
        expect(
          source,
          `${file} claims "${claim}", which is not what happens. A copy keeps ` +
            "writing invoices and credit notes on purpose; what changes is that " +
            "its Xero CONTACTS can no longer reach anybody, and on the club's " +
            "real organisation that is a real edit (INV-CONFIG-005).",
        ).not.toContain(claim);
      }
    }
  });

  it("renders the rewritten contacts, not just a count of them", () => {
    /*
      #3036 review P0-5, and a gap a mutation probe found in this file's first
      version: disabling the whole list rendered nothing and every case here
      still passed. The list is the ONLY thing that makes the repair actionable
      — the operator has to know which contacts, whose they are, and where to
      click — and the guide's repair steps refer to it by name ("using the links
      below"), so a screen without it makes the documentation wrong too.

      A SOURCE census AS WELL AS a render test, not instead of one. The earlier
      version of this comment said there was no harness for this screen and that
      inventing one was the worse trade, and that was false — `react-dom/server`
      and `@testing-library/react` are both here and dozens of admin components
      are rendered in tests. The render test is
      `src/components/admin/__tests__/environment-xero-containment.test.tsx`. This
      census earns its place on a different question: it pins WHICH FIELDS reach
      the screen and that no email address can, which markup assertions express
      poorly and which is the property an operator's repair depends on.
    */
    const block = readModule(
      "src/components/admin/environment-xero-containment.tsx",
    );
    // Anti-vacuity: this really is the component, and it really is non-trivial.
    expect(block.length).toBeGreaterThan(2000);
    expect(block).toContain("export function EnvironmentXeroContainment(");
    // It reads the list from the payload, keys the block on there being
    // something to repair, and renders one row per contact.
    expect(
      block,
      "the component must read the rewritten-contact list from the payload",
    ).toContain("containment.rewritten");
    expect(
      block,
      "the list block must be keyed on there being something to repair, so an " +
        "installation with nothing to fix shows no repair instructions",
    ).toContain("listed.length > 0 ?");
    expect(
      block,
      "and it must map over that list rather than reporting only a count",
    ).toContain("listed.map((contact) =>");
    for (const field of [
      "contact.xeroContactUrl",
      "contact.memberName",
      "contact.memberId",
      "contact.rewrittenAt",
    ]) {
      expect(block, `${field} must reach the screen`).toContain(field);
    }
    // The repair steps are what the operator guide's section points at.
    expect(block).toContain("xeroContainmentRepairSteps()");
    expect(
      block,
      "the total must still be shown when the list is truncated, so a page of " +
        "fifty cannot read as the whole of the damage",
    ).toContain("containment.rewrittenContacts > listed.length");
    // No email address may reach this screen, in any form.
    expect(
      block,
      "the payload carries no member email address and this screen must not " +
        "invent one",
    ).not.toMatch(/contact\.(?:email|emailAddress)/);
  });

  it("says opposite things about Xero for a confirmed copy and an undeclared installation", () => {
    /*
      A copy IS containing, and the number an operator wants is how much of the
      club's accounting it has edited. An UNDECLARED installation is containing
      nothing, because nothing is reaching Xero at all — every invoice, credit
      note and contact write is refused. One sentence for both would tell the
      operator of an undeclared LIVE site that their Xero is fine while their
      invoicing has stopped. Same rule #3035 reached for the withheld-email
      block, arrived at here from the opposite direction.
    */
    /*
      The renderer moved into its own client component when the panel outgrew
      its file-size budget (#3036 review P2-15). The subject moved with it, so
      this case follows it rather than pinning a path.
    */
    const panel = readModule(
      "src/components/admin/environment-xero-containment.tsx",
    );
    const start = panel.indexOf("function describeXeroContainment(");
    expect(start, "the containment renderer must exist").toBeGreaterThan(-1);
    const rest = panel.slice(start);
    const end = rest.indexOf("\n}\n");
    expect(end).toBeGreaterThan(0);
    const body = rest.slice(0, end);
    /*
      The region really is the function's BODY and not its multi-line return
      type — the exact vacuity a probe found in this file's neighbour during
      #3035. A body that branches on the role and renders three states is
      thousands of characters, and it has to contain sentences.
    */
    expect(body.length, "the renderer's body must be bounded, not a signature").toBeGreaterThan(
      1200,
    );
    expect(body).toContain("state.role");
    expect(
      body,
      "the undeclared state must be answered FIRST and separately: it is not " +
        "containing anything, and a count means something different there",
    ).toContain('state.role === "UNKNOWN"');
    // And it distinguishes the DECLARED-production installation whose override
    // cannot be read, which also resolves UNKNOWN and for which "declare the
    // role" is the wrong repair (#3036 review P1-10).
    expect(
      body,
      "the two UNKNOWN causes have different repairs and must not share a sentence",
    ).toContain('state.declarationKind === "production"');
    const unknownBranch = body.slice(
      body.indexOf('state.role === "UNKNOWN"'),
      body.indexOf("if (!containment.available)"),
    );
    expect(
      unknownBranch.length,
      "the undeclared branch must hold its own wording, not fall through",
    ).toBeGreaterThan(300);
    expect(
      unknownBranch,
      "the undeclared branch must say that nothing is WRITTEN to Xero",
    ).toMatch(/Nothing is being written to Xero/);
    /*
      WRITTEN, NOT REACHED, and this case used to require the opposite. Its
      message said the branch "must say that nothing is reaching Xero, which is
      what is actually happening there" — and that was false twice over. Contact
      resolution refused while seven writers that never touch it carried on, and
      READS were never blocked at all and deliberately still are not: a read
      marks nothing in the club's books, and an operator working out why their
      invoicing has stopped needs the Xero screens to load. So the branch has to
      name what is refused and disclose that reading still works, or the operator
      of an undeclared LIVE site reads "nothing is reaching Xero" and concludes
      the connection is broken.
    */
    expect(
      unknownBranch,
      "the undeclared branch must enumerate what is refused, not gesture at it",
    ).toMatch(/invoice, credit note, payment, allocation or contact/);
    expect(
      unknownBranch,
      "and must say that READING from Xero still works",
    ).toMatch(/Reading from Xero still works/);
    // And the block is rendered for BOTH states, never for PRODUCTION — where
    // containment never runs and the table is empty by definition, so a
    // "0 contacts" line would be noise.
    expect(
      panel,
      "the block must render for a confirmed copy and an undeclared installation, " +
        "and for NEITHER production (where containment never runs and the table " +
        "is empty by definition, so a zero would be noise)",
    ).toContain(
      'if (props.role !== "NON_PRODUCTION" && props.role !== "UNKNOWN") return null;',
    );
    // And the panel really does render it, or the component above is dead code.
    expect(
      readModule("src/components/admin/environment-safety-panel.tsx"),
      "the panel must still mount the containment block",
    ).toContain("<EnvironmentXeroContainment");
  });

});
