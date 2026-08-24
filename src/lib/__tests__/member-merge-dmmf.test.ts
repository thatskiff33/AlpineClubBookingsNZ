import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  MEMBER_MERGE_RELATION_SPECS,
  MEMBER_MERGE_FK_LESS_MOVE_COLUMNS,
  MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS,
  diffRelationSpecCoverage,
  memberRelationNamesFromDmmf,
  parseFkLessMemberIdColumns,
  parseMemberRelationOwnerKeys,
} from "@/lib/member-merge";

const schemaText = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
);

const specKeys = MEMBER_MERGE_RELATION_SPECS.map((s) => s.key);

// The FK-less-scalar census below ENFORCES INV-LIFE-078
// (`docs/invariants/membership-lifecycle.md`), which names this file. Its
// failure message repeats the id, so whoever trips it is handed the rule rather
// than having to go and find it (#2691).

describe("member-merge relation classification completeness", () => {
  it("classifies queued hosting actor attribution as a live FK-less move", () => {
    expect(MEMBER_MERGE_FK_LESS_MOVE_COLUMNS).toContainEqual({
      key: "HostingCoverageReevaluation.actorMemberId",
      delegate: "hostingCoverageReevaluation",
      column: "actorMemberId",
    });
    expect(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS).not.toContain(
      "HostingCoverageReevaluation.actorMemberId",
    );
    expect(schemaText).toMatch(
      /model HostingCoverageReevaluation[\s\S]*?actorMemberId\s+String\?/,
    );
  });

  it("classifies every Member FK-owning relation exactly once (no missing, no extra)", () => {
    const ownerKeys = parseMemberRelationOwnerKeys(schemaText);
    const { missing, extra } = diffRelationSpecCoverage(ownerKeys, specKeys);

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("has no duplicate spec keys (each relation in exactly one bucket)", () => {
    const seen = new Set<string>();
    for (const key of specKeys) {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("FAILS when the schema grows an unclassified Member relation (fixture proof)", () => {
    const injected = `${schemaText}
model FutureThing {
  id        String @id @default(cuid())
  memberId  String
  member    Member @relation("FutureThingMember", fields: [memberId], references: [id], onDelete: Cascade)
}
`;
    const ownerKeys = parseMemberRelationOwnerKeys(injected);
    const { missing } = diffRelationSpecCoverage(ownerKeys, specKeys);

    expect(missing).toContain("FutureThing.member");
  });

  it("FAILS when a spec key no longer exists in the schema (fixture proof)", () => {
    const ownerKeys = parseMemberRelationOwnerKeys(schemaText);
    const { extra } = diffRelationSpecCoverage(ownerKeys, [
      ...specKeys,
      "GhostModel.member",
    ]);

    expect(extra).toContain("GhostModel.member");
  });

  it("cross-checks against the runtime DMMF: the trimmed DMMF exposes Member relations", () => {
    const relNames = memberRelationNamesFromDmmf(
      Prisma.dmmf.datamodel.models as unknown as {
        name: string;
        fields: { type: string; relationName?: string }[];
      }[],
    );
    expect(relNames.size).toBeGreaterThan(0);
  });

  it("parses a relation field with attributes BEFORE @relation (fail-open regression proof)", () => {
    const injected = `${schemaText}
model AttributeFirstThing {
  id       String @id @default(cuid())
  memberId String
  member   Member @ignore @relation("AttributeFirstThingMember", fields: [memberId], references: [id], onDelete: Cascade)
}
`;
    const ownerKeys = parseMemberRelationOwnerKeys(injected);
    expect(ownerKeys).toContain("AttributeFirstThing.member");
  });

  // ---------------------------------------------------------------------
  // Fail-closed cross-check: the trimmed runtime DMMF (which drops isList /
  // relationFromFields) supplies the authoritative UNIVERSE of Member-typed
  // relation fields; a deliberately loose schema scan supplies only their
  // declared type token (Member / Member? / Member[]). Every non-list field
  // in that universe must map to a parsed owner key, so a field the strict
  // owner-key parser fails to parse (attribute quirks, formatting) becomes a
  // CI failure instead of silently dying with the loser. All singular Member
  // fields carry `fields:` today — verified at review time.
  // ---------------------------------------------------------------------

  /** `Model.field` -> declared type token for every Member-typed field. */
  function memberFieldTypeTokens(schema: string): Map<string, string> {
    const map = new Map<string, string>();
    let model: string | null = null;
    for (const line of schema.split(/\r?\n/)) {
      const mm = line.match(/^model\s+(\w+)\s*\{/);
      if (mm) {
        model = mm[1];
        continue;
      }
      if (line.trim() === "}") {
        model = null;
        continue;
      }
      const fm = line.match(/^\s*(\w+)\s+(Member(?:\[\]|\?)?)(\s|$)/);
      if (fm && model) map.set(`${model}.${fm[1]}`, fm[2]);
    }
    return map;
  }

  function unparsedSingularMemberFields(
    models: readonly {
      name: string;
      fields: readonly { name: string; kind: string; type: string }[];
    }[],
    ownerKeys: ReadonlySet<string>,
    typeTokens: ReadonlyMap<string, string>,
  ): string[] {
    const unparsed: string[] = [];
    for (const model of models) {
      for (const field of model.fields) {
        if (field.kind !== "object" || field.type !== "Member") continue;
        const key = `${model.name}.${field.name}`;
        // List back-refs own no FK. A field the loose scan cannot even see
        // (no type token) is NEVER skipped — it is reported as unparsed.
        if (typeTokens.get(key) === "Member[]") continue;
        if (!ownerKeys.has(key)) unparsed.push(key);
      }
    }
    return unparsed;
  }

  it("every singular Member-typed DMMF field maps to a parsed owner key (fail-closed)", () => {
    const ownerKeys = new Set(parseMemberRelationOwnerKeys(schemaText));
    const typeTokens = memberFieldTypeTokens(schemaText);
    const models = Prisma.dmmf.datamodel.models as unknown as {
      name: string;
      fields: { name: string; kind: string; type: string }[];
    }[];
    // Sanity: the walk actually sees at least as many singular fields as the
    // spec table classifies.
    const singularCount = models
      .flatMap((m) => m.fields.map((f) => ({ model: m.name, ...f })))
      .filter(
        (f) =>
          f.kind === "object" &&
          f.type === "Member" &&
          typeTokens.get(`${f.model}.${f.name}`) !== "Member[]",
      ).length;
    expect(singularCount).toBeGreaterThanOrEqual(MEMBER_MERGE_RELATION_SPECS.length);

    expect(unparsedSingularMemberFields(models, ownerKeys, typeTokens)).toEqual([]);
  });

  it("FAILS on a hypothetical relation the owner-key parser cannot see (fixture proof)", () => {
    const ownerKeys = new Set(parseMemberRelationOwnerKeys(schemaText));
    const typeTokens = memberFieldTypeTokens(schemaText);
    const withGhost = [
      {
        name: "GhostModel",
        fields: [{ name: "member", kind: "object", type: "Member" }],
      },
    ];
    // GhostModel.member is in the (fixture) DMMF universe but invisible to
    // both schema scans -> reported, never silently skipped.
    expect(unparsedSingularMemberFields(withGhost, ownerKeys, typeTokens)).toEqual([
      "GhostModel.member",
    ]);
  });

  // ---------------------------------------------------------------------
  // #2437: the `selfRelation` flag routes a Member->Member FK into BOTH
  // #2445's master-row exclusion / id-bounded sweep and the under-lock
  // family-link drift re-check. The flag is hand-written on the spec, and
  // before this test NOTHING failed when it was omitted: the completeness
  // tests only force a spec to exist, and the frozen four-name lists punish
  // ADDING the flag (two tests to update) while omission passed every gate —
  // silently reopening the #2445 corruption arm (an unbounded,
  // master-inclusive sweep of the new column can make the master its own
  // guardian/parent) and skipping the drift re-check entirely. The expected
  // set is derived from the schema itself, so the omission now fails CI.
  // ---------------------------------------------------------------------

  /** Singular Member-typed FK-owning relations declared ON model Member. */
  function singularMemberSelfFkKeys(
    typeTokens: ReadonlyMap<string, string>,
    ownerKeys: ReadonlySet<string>,
  ): string[] {
    return [...typeTokens.keys()]
      .filter(
        (key) =>
          key.startsWith("Member.") &&
          typeTokens.get(key) !== "Member[]" &&
          ownerKeys.has(key),
      )
      .sort();
  }

  it("flags every singular Member->Member FK-owning relation `selfRelation`, and only those, all bucket move (#2437)", () => {
    const expectedKeys = singularMemberSelfFkKeys(
      memberFieldTypeTokens(schemaText),
      new Set(parseMemberRelationOwnerKeys(schemaText)),
    );
    // Sanity: the schema derivation really sees today's four self-FKs.
    expect(expectedKeys.length).toBeGreaterThanOrEqual(4);

    const flagged = MEMBER_MERGE_RELATION_SPECS.filter((s) => s.selfRelation);
    // Omitting the flag on a Member self-FK fails here...
    expect(flagged.map((s) => s.key).sort()).toEqual(expectedKeys);
    // ...as does flagging anything that is not a Member self-FK, or classifying
    // a Member-model spec that is somehow not one.
    expect(
      MEMBER_MERGE_RELATION_SPECS.filter((s) => s.model === "Member")
        .map((s) => s.key)
        .sort(),
    ).toEqual(expectedKeys);
    // The drift differ's expected-value model and the id-bounded sweep both
    // assume the `move` transform for every flagged column.
    for (const s of flagged) {
      expect(s.bucket, `${s.key} must be bucket "move"`).toBe("move");
    }
  });

  it("FAILS when a fifth Member self-FK arrives without the flag (fixture proof)", () => {
    // Simulate the omission: the schema gains Member.guardian but the spec
    // table's flagged set is unchanged. The equality above must reject it.
    const ownerKeys = new Set(parseMemberRelationOwnerKeys(schemaText));
    ownerKeys.add("Member.guardian");
    const typeTokens = new Map(memberFieldTypeTokens(schemaText));
    typeTokens.set("Member.guardian", "Member?");

    const expectedKeys = singularMemberSelfFkKeys(typeTokens, ownerKeys);
    const flaggedKeys = MEMBER_MERGE_RELATION_SPECS.filter((s) => s.selfRelation)
      .map((s) => s.key)
      .sort();

    expect(expectedKeys).toContain("Member.guardian");
    expect(flaggedKeys).not.toEqual(expectedKeys);
  });

  // ---------------------------------------------------------------------
  // #2243: FK-less member-id columns. The relation walk above is exact but
  // structurally blind to a bare `String` column holding a member id, and the
  // documented snapshot list used to be hand-kept and self-described as
  // non-exhaustive — so `CalendarEvent.createdById` and
  // `CalendarEventSeries.createdById` escaped BOTH with nothing in CI to
  // notice. These tests make the detectable slice of that class accounted for
  // and self-maintaining.
  // ---------------------------------------------------------------------

  /**
   * The detected set, frozen as of #2243. The `arrayContaining` assertion below
   * is DIRECTIONAL on purpose: the set may GROW (a new FK-less member-id column
   * is added, caught by the "documents every…" test, which forces it into
   * `MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS`), but it may never SHRINK silently.
   * A shrink means the detector stopped seeing a column it used to see — a
   * regression in `parseFkLessMemberIdColumns` (a comment quirk, a formatting
   * change) that would otherwise pass every other test in this file, because
   * every one of them only checks that what IS detected is documented. Removing
   * a column from the schema is the legitimate reason to edit this list; do that
   * deliberately, in the same commit as the schema change.
   */
  const FROZEN_DETECTED_FK_LESS_MEMBER_ID_COLUMNS = [
    "AiAssistantSettings.updatedByMemberId",
    "AiAssistantUsageEvent.memberId",
    "AuditLog.memberId",
    "AuditLog.subjectMemberId",
    "BedAllocationSettings.updatedByMemberId",
    "BookingMessageOverride.updatedByMemberId",
    "BookingModification.memberId",
    "BookingRequest.reviewedByMemberId",
    "BookingRequestQuote.createdByMemberId",
    "BookingRequestSettings.updatedByMemberId",
    "CalendarEvent.createdById",
    "CalendarEventSeries.createdById",
    "ClubIdentitySettings.updatedByMemberId",
    "ClubTimeSettings.updatedByMemberId",
    "ClubModuleSettings.updatedByMemberId",
    "EmailMessageSetting.updatedByMemberId",
    "EmailTemplateOverride.updatedByMemberId",
    "FinanceSyncRun.requestedByMemberId",
    "IntegrationWizardProgress.updatedByMemberId",
    "InternetBankingPaymentSettings.updatedByMemberId",
    "LodgeInstruction.updatedByMemberId",
    "LodgeSettings.updatedByMemberId",
    "LoginSecuritySetting.updatedByMemberId",
    "MemberFieldsSettings.updatedByMemberId",
    "MemberGuestSettings.updatedByMemberId",
    "MemberInduction.createdByMemberId",
    "MemberLifecycleActionRequest.memberId",
    "MembershipCancellationSetting.updatedByMemberId",
    "MembershipLockoutSettings.updatedByMemberId",
    "MembershipNominationSettings.updatedByMemberId",
    "MembershipSubscriptionBillingSettings.updatedByMemberId",
    "MembershipSubscriptionChargeCoverage.memberId",
    "NotificationDeliveryPolicy.updatedByMemberId",
    "PageContent.updatedByMemberId",
    "PublicContentSettings.updatedByMemberId",
    "SetupProgress.completedByMemberId",
    "SiteBanner.createdByMemberId",
    "SiteBanner.updatedByMemberId",
    "SiteContent.updatedByMemberId",
    "XeroGroupingSettings.updatedByMemberId",
    "XeroMemberGroupingDryRun.createdByMemberId",
    "XeroSyncOperation.createdByMemberId",
  ];

  it("documents every FK-less member-id column the schema scan can find", () => {
    const detected = parseFkLessMemberIdColumns(schemaText);
    const documented = new Set(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS);

    expect(
      detected.filter((c) => !documented.has(c)),
      "INV-LIFE-078 (docs/invariants/membership-lifecycle.md): a member merge " +
        "leaves FK-less scalar member-id columns pointing at the loser's id as " +
        "immutable history, and every column the schema scan can see must be " +
        "enumerated in MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS. The hand-kept list " +
        "is how CalendarEvent.createdById and CalendarEventSeries.createdById " +
        "escaped both the relation walk and the documentation (#2243). Classify " +
        "the column above — snapshot, or a live move — and add it there.",
    ).toEqual([]);
  });

  it("never silently SHRINKS the detected set (frozen floor, both directions)", () => {
    // Grow-only guard: everything frozen at #2243 must still be detected. A
    // detector regression that stops seeing a column is invisible to every other
    // test here, all of which only assert that what IS detected is documented.
    const detected = parseFkLessMemberIdColumns(schemaText);
    expect(detected).toEqual(
      expect.arrayContaining(FROZEN_DETECTED_FK_LESS_MEMBER_ID_COLUMNS),
    );
    // ...and the frozen list is a real snapshot of this schema, not a stale
    // fiction: nothing in it names a column the schema no longer has.
    expect(
      FROZEN_DETECTED_FK_LESS_MEMBER_ID_COLUMNS.filter(
        (c) => !new Set(detected).has(c),
      ),
    ).toEqual([]);
  });

  it("FAILS when the detector stops seeing a frozen column (shrink-direction fixture proof)", () => {
    // Simulate the regression the guard exists for: a detector that misses
    // `CalendarEvent.createdById`. The frozen assertion must reject it.
    const detected = parseFkLessMemberIdColumns(schemaText).filter(
      (c) => c !== "CalendarEvent.createdById",
    );
    expect(() =>
      expect(detected).toEqual(
        expect.arrayContaining(FROZEN_DETECTED_FK_LESS_MEMBER_ID_COLUMNS),
      ),
    ).toThrow();
  });

  it("strips // comments before matching, so a commented-out @relation cannot hide a column", () => {
    // The reviewer's fixture. `Forged.memberId` is a bare String column, but the
    // trailing comment mentions a `@relation(fields: [memberId])`. Parsing the
    // comment registers a PHANTOM foreign key on the model, the column is treated
    // as classified, and it vanishes from the detector's output — a silent
    // escape of exactly the #2243 kind, with nothing else in CI to notice.
    const injected = `${schemaText}
model Forged {
  id       String @id @default(cuid())
  memberId String // was: member Member @relation(fields: [memberId], references: [id])
  note     String?
}
`;
    expect(parseFkLessMemberIdColumns(injected)).toContain("Forged.memberId");
  });

  it("does not treat a // inside a quoted string as the start of a comment", () => {
    // Stripping at the first `//` regardless of quoting would truncate this
    // relation line before its `fields: [memberId]`, so `memberId` would look
    // FK-less and be reported as an undocumented snapshot column — a false
    // POSITIVE that costs a real reviewer's time. The stripper is quote-aware.
    const injected = `${schemaText}
model QuotedRelationThing {
  id       String @id @default(cuid())
  memberId String
  member   Member @relation("QuotedRelationThing//Member", fields: [memberId], references: [id], onDelete: Cascade)
}
`;
    expect(parseFkLessMemberIdColumns(injected)).not.toContain(
      "QuotedRelationThing.memberId",
    );
  });

  it("names the two columns that motivated the guard (#2243)", () => {
    const detected = parseFkLessMemberIdColumns(schemaText);
    expect(detected).toContain("CalendarEvent.createdById");
    expect(detected).toContain("CalendarEventSeries.createdById");
    expect(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS).toContain("CalendarEvent.createdById");
    expect(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS).toContain(
      "CalendarEventSeries.createdById",
    );
  });

  it("FAILS when the schema grows an undocumented FK-less member-id column (fixture proof)", () => {
    // The next `CalendarEvent.createdById`: a bare String named like a Member FK
    // column used elsewhere in the schema, owning no relation of its own. It is
    // invisible to the relation walk, so this detector is the only thing between
    // it and a silent escape.
    const injected = `${schemaText}
model FutureAuditThing {
  id          String @id @default(cuid())
  createdById String
  note        String?
}
`;
    const detected = parseFkLessMemberIdColumns(injected);
    const documented = new Set(MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS);

    expect(detected).toContain("FutureAuditThing.createdById");
    expect(detected.filter((c) => !documented.has(c))).toEqual([
      "FutureAuditThing.createdById",
    ]);
  });

  it("does not report a column that DOES own a Member relation (no false positives)", () => {
    // `Booking.createdById` owns `Booking.createdBy Member @relation(...)`, so it
    // is classified, not a snapshot column — the detector must leave it alone or
    // the two lists would fight over it.
    const detected = parseFkLessMemberIdColumns(schemaText);
    expect(detected).not.toContain("Booking.createdById");
    expect(detected).not.toContain("Booking.memberId");
  });

  it("keeps the detected set and the classified relation columns disjoint", () => {
    const specColumns = new Set(
      MEMBER_MERGE_RELATION_SPECS.map((s) => `${s.model}.${s.column}`),
    );
    for (const column of parseFkLessMemberIdColumns(schemaText)) {
      expect(
        specColumns.has(column),
        `${column} is both classified and detected as FK-less`,
      ).toBe(false);
    }
  });

  it("every spec key names a real DMMF model.field whose type is Member (catches typos)", () => {
    const modelByName = new Map(
      Prisma.dmmf.datamodel.models.map((m) => [m.name, m]),
    );
    for (const s of MEMBER_MERGE_RELATION_SPECS) {
      const model = modelByName.get(s.model);
      expect(model, `unknown model ${s.model}`).toBeDefined();
      const field = model?.fields.find((f) => f.name === s.field);
      expect(field, `unknown field ${s.key}`).toBeDefined();
      expect(field?.type, `${s.key} is not a Member relation`).toBe("Member");
    }
  });
});
