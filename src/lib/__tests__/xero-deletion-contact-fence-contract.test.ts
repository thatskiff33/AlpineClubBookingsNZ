import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function between(
  input: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = input.indexOf(startMarker);
  expect(start, `missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = input.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start);
  return input.slice(start, end);
}

function expectOrdered(input: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const at = input.indexOf(marker, previous + 1);
    expect(at, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(
      previous,
    );
    previous = at;
  }
}

describe("Xero contact/account-deletion lock topology mutation pins (#2597)", () => {
  it("reserves only after the Member KEY SHARE re-read and ambiguous-create proof", () => {
    const block = between(
      source("src/lib/xero-contacts.ts"),
      "export async function reserveMemberContactCreateOperation<T>(",
      "export interface XeroContactUpdateData",
    );

    expectOrdered(block, [
      "FOR KEY SHARE",
      "tx.member.findUnique",
      "assertMemberAvailableForXeroContactChange(locked)",
      "ambiguousMemberContactCreateReservationWhere(memberId)",
      "const plan = buildPlan(locked)",
      "startXeroSyncOperation({",
    ]);
  });

  it("commits the reservation before authentication/provider work and re-locks before local attribution", () => {
    const block = between(
      source("src/lib/xero-contacts.ts"),
      "export async function createXeroContactForMember(",
      "export async function getContactFirstInvoiceDate(",
    );

    expectOrdered(block, [
      // #3036: the environment role is read BEFORE the reservation, so an
      // undeclared installation opens no reservation and reaches no provider.
      "resolveXeroContactEmailPolicy()",
      "reserveMemberContactCreateOperation(memberId",
      "buildMemberXeroContactCreatePayload(locked, emailPolicy)",
      "getAuthenticatedXeroClient()",
      "persistProviderCreatedContactProofOrThrow(",
      "lockMemberForXeroContactLink(tx, memberId)",
      "tx.member.update",
      // #3036: and containment is proved after the local link commits, before
      // the id is returned to anything that can raise a document.
      "ensureXeroContactContained({",
    ]);
  });

  it("keeps the manual Member pointer and canonical CONTACT ledger in one transaction", () => {
    const block = between(
      source("src/lib/xero-manual-contact-link.ts"),
      "export async function commitManualXeroContactLink(",
      "  });\n}",
    );

    expectOrdered(block, [
      "db.$transaction",
      "lockMemberForManualXeroContactLink(tx, input.memberId)",
      "tx.member.update",
      "upsertXeroObjectLink(",
      "{ store: tx }",
      // #2623 T7: and closes the create this link just completed, under the
      // same fence, so the operation cannot outlive its own recovery.
      "closeProviderCreatedContactRecoveryForLinkedContact(",
    ]);
  });

  /**
   * #2623 T7. The member detail page and the two lifecycle refusals must ask the
   * SAME question. They did not: the page's only Xero signal short-circuited on
   * `Member.xeroContactId`, while neither blocker predicate consults the link, so
   * a linked-but-blocked member rendered clean and got refused anyway.
   */
  it("reads one blocker predicate for merge, deletion and the member display", () => {
    for (const relativePath of [
      "src/lib/member-merge.ts",
      "src/lib/admin-member-detail-service.ts",
    ]) {
      expect(source(relativePath)).toContain(
        "findMemberContactChangeMergeBlocker(",
      );
    }

    const recovery = source("src/lib/xero-contact-create-recovery.ts");
    // Every consumer funnels through the one reader rather than re-deriving it.
    expect(recovery).toContain(
      "export async function findMemberContactChangeMergeBlocker(",
    );
    expect(recovery).toMatch(
      /hasMemberContactChangeMergeBlocker[\s\S]{0,240}findMemberContactChangeMergeBlocker\(memberId, db\)/,
    );
    expect(recovery).toMatch(
      /assertNoMemberContactChangeBlockerForDeletion[\s\S]{0,320}findMemberContactChangeMergeBlocker\(memberId, db\)/,
    );

    // And the display renders it, so a refused member cannot look clean.
    expect(
      source(
        "src/app/(admin)/admin/members/[id]/_components/member-xero-contact-summary.tsx",
      ),
    ).toContain("member.xeroContactLifecycleBlocker");
  });

  /**
   * #2623 T2: the repair path reaches the create reservation whenever Xero
   * produced no match — deterministically for a walk-in placeholder owner whose
   * email search is skipped by design. The reservation must accept explicit
   * repair intent, and repair must ask Xero by name BEFORE creating so a live
   * same-named contact is re-linked instead of duplicated.
   */
  it("lets an explicit repair reserve, but only after a name re-resolution", () => {
    const contacts = source("src/lib/xero-contacts.ts");
    const reservation = between(
      contacts,
      "export async function reserveMemberContactCreateOperation<T>(",
      "export async function reserveMemberContactUpdateOperation<T>(",
    );
    expect(reservation).toContain(
      "if (locked.xeroContactId && !options?.repairExistingLink)",
    );

    const findOrCreate = between(
      contacts,
      "export async function findOrCreateXeroContact(",
      "async function syncContactGroupsBestEffort(",
    );
    expectOrdered(findOrCreate, [
      // #3036: FIRST, before the member row is even read — an undeclared
      // installation must reach nothing at all.
      "resolveXeroContactEmailPolicy()",
      "isPlaceholderContactEmail(member.email)",
      "options?.repairExistingLink && previousXeroContactId",
      "findExistingXeroContactByExactName({",
      "reserveMemberContactCreateOperation(",
      "accountingApi.createContacts(",
    ]);
  });

  it("re-checks the complete Xero blocker under the deletion Member lock before anonymising", () => {
    const recoverySource = source("src/lib/xero-contact-create-recovery.ts");
    const recovery = between(
      recoverySource,
      "export async function lockMemberForAccountDeletionXeroFence(",
      "export async function getMemberContactCreateRecoveryPending(",
    );
    expectOrdered(recovery, [
      "lockMemberRowForXeroFence(db, memberId)",
      "assertNoMemberContactChangeBlockerForDeletion(memberId, db)",
    ]);

    // #2627: the deletion fence takes the row lock WITHOUT the contact-writer
    // availability assert. That assert refuses any member carrying the
    // anonymisation marker — which deletion itself writes — so running it here
    // made an already-anonymised member impossible to hard delete, with an
    // unmapped 500 as the only signal. Deletion must never route through the
    // asserting helper; the contact writers still must.
    expect(recovery).not.toContain("lockMemberForXeroContactLink(");
    expect(recovery).not.toContain("assertMemberAvailableForXeroContactChange");
    expectOrdered(
      between(
        recoverySource,
        "export async function lockMemberForXeroContactLink(",
        "export async function completeMemberContactOperation(",
      ),
      [
        "lockMemberRowForXeroFence(db, memberId)",
        "assertMemberAvailableForXeroContactChange(member)",
      ],
    );

    const route = source("src/app/api/admin/deletion-requests/[id]/route.ts");
    expectOrdered(route, [
      "lockMemberForAccountDeletionXeroFence(tx, member.id)",
      "await tx.member.update",
      "passwordHash: DELETED_ACCOUNT_PASSWORD_HASH",
      "await tx.xeroObjectLink.updateMany",
    ]);
  });

  it("reserves member updates before provider work and completes the link under the same Member fence", () => {
    const contactSource = source("src/lib/xero-contacts.ts");
    const update = contactSource.slice(
      contactSource.indexOf("export async function updateXeroContact("),
    );
    expectOrdered(update, [
      // #3036: the role is read before the reservation here too.
      "resolveXeroContactEmailPolicy()",
      "reserveMemberContactUpdateOperation(",
      "try {",
      "getAuthenticatedXeroClient()",
      "accountingApi.updateContact(",
      "completeMemberContactUpdateOperation(",
      "failXeroSyncOperation(operation.id, error)",
    ]);
    const completion = between(
      contactSource,
      "export async function completeMemberContactUpdateOperation(",
      "export interface XeroContactUpdateData",
    );
    expectOrdered(completion, [
      "lockMemberForXeroContactLink(tx, memberId)",
      "completeXeroSyncOperation(operationId, completion, { store: tx })",
    ]);

    const genericCompletion = between(
      source("src/lib/xero-contact-create-recovery.ts"),
      "export async function completeMemberContactOperation(",
      "export async function applyInboundMemberContactPatch(",
    );
    expectOrdered(genericCompletion, [
      "db.$transaction",
      "lockMemberForXeroContactLink(tx, memberId)",
      "locked.xeroContactId !== expectedXeroContactId",
      "completeXeroSyncOperation(operationId, completion, { store: tx })",
    ]);
    expect(source("src/lib/xero-contact-groups.ts")).toContain(
      "completeMemberContactOperation(",
    );
  });

  it("keeps every profile CONTACT UPDATE producer on the Member-scoped fence", () => {
    for (const relativePath of [
      "src/lib/admin-member-detail-service.ts",
      "src/app/api/auth/confirm-email-change/route.ts",
      "src/app/api/profile/route.ts",
      "src/app/api/members/family/[memberId]/details/route.ts",
    ]) {
      const producer = source(relativePath);
      expect(producer).toContain("updateXeroContact(");
      expect(producer).toMatch(
        /updateXeroContact\([\s\S]*?localModel:\s*"Member"[\s\S]*?localId:/,
      );
    }
  });

  it("keeps inbound member PII and FK-less contact links behind one row fence", () => {
    const recovery = between(
      source("src/lib/xero-contact-create-recovery.ts"),
      "export async function applyInboundMemberContactPatch(",
      "export async function lockMemberForManualXeroContactLink(",
    );
    expectOrdered(recovery, [
      "db.$transaction",
      "lockMemberForXeroContactLink(tx, input.memberId)",
      "tx.member.findUnique",
      "await tx.member.update",
      "upsertXeroObjectLink(",
      "{ store: tx }",
    ]);

    for (const relativePath of [
      "src/lib/xero-bulk-contact-sync.ts",
      "src/lib/xero-inbound/contact.ts",
      "src/lib/xero-member-import.ts",
    ]) {
      const participant = source(relativePath);
      expect(participant).toContain("applyInboundMemberContactPatch(");
      expect(participant).not.toContain("prisma.member.update(");
    }

    const oneContactImport = source(
      "src/app/api/admin/xero/import-member-contact/route.ts",
    );
    expectOrdered(oneContactImport, [
      "prisma.$transaction",
      "tx.member.create",
      "ensureMemberAccessRolesFromCompatibilityFields(tx",
      "upsertXeroObjectLink(",
      "{ store: tx }",
    ]);

    const historicalBackfill = between(
      source("src/lib/xero-hardening-backfill.ts"),
      "export async function backfillMemberContactLink(",
      "async function backfillMemberContactLinks(",
    );
    expectOrdered(historicalBackfill, [
      "db.$transaction",
      "lockMemberForXeroContactLink(tx, memberId)",
      "locked.xeroContactId !== expectedXeroContactId",
      "upsertXeroObjectLink(",
      "{ store: tx }",
      "tx.xeroSyncOperation.create",
    ]);
  });

  it("builds member UPDATE payloads from the locked post-reservation snapshot", () => {
    const contacts = source("src/lib/xero-contacts.ts");
    const update = contacts.slice(
      contacts.indexOf("export async function updateXeroContact("),
    );
    expectOrdered(update, [
      "reserveMemberContactUpdateOperation(",
      "buildXeroContactUpdatePayload(locked)",
      "getAuthenticatedXeroClient()",
      "accountingApi.updateContact(",
    ]);

    const bulk = between(
      source("src/lib/xero-bulk-contact-sync.ts"),
      "async function repairXeroContactNameOrderIfNeeded(",
      "export async function syncContactsFromXero(",
    );
    expectOrdered(bulk, [
      "reserveMemberContactUpdateOperation(",
      "getXeroContactNameOrderRepair(locked",
      "requestPayload: payload",
      "accountingApi.updateContact(",
      "completeMemberContactUpdateOperation(",
    ]);
  });

  it("claims each deletion decision before its status-specific mutation or email", () => {
    const route = source("src/app/api/admin/deletion-requests/[id]/route.ts");
    const reject = between(
      route,
      'if (body.action === "reject") {',
      "// --- APPROVE ---",
    );
    expectOrdered(reject, [
      "claimDeletionRequestDecision(prisma",
      'decision: "REJECTED"',
      "sendAccountDeletionRejectedEmail(",
    ]);
    const approveTransaction = between(
      route,
      "await prisma.$transaction(async (tx) => {",
      "memberAnonymised = true",
    );
    expectOrdered(approveTransaction, [
      "claimDeletionRequestDecision(tx",
      'decision: "APPROVED"',
      "await tx.member.update",
    ]);
    expect(approveTransaction).not.toContain("tx.deletionRequest.update(");
  });

  it("never falls back to stored PII for a Member contact-update retry", () => {
    const retry = between(
      source("src/lib/xero-operation-retry.ts"),
      "const retryInput =\n      operation.localModel",
      'if (operation.entityType === "INVOICE" && operation.operationType === "CREATE") {',
    );
    expect(retry).toContain('operation.localModel === "Member"');
    expect(retry).toContain("buildCurrentMemberContactUpdateRetryInput(operation)");
    expect(retry).not.toContain(
      "buildCurrentMemberContactUpdateRetryInput(operation)) ??",
    );
  });

  it("maps contention to privacy-safe route errors instead of provider detail", () => {
    const push = source("src/app/api/admin/members/[id]/xero-push/route.ts");
    const link = source("src/app/api/admin/members/[id]/xero-link/route.ts");
    const deletion = source("src/app/api/admin/deletion-requests/[id]/route.ts");

    expect(push).toContain("XeroContactCreateInProgressError");
    expect(push).toContain("XeroMemberUnavailableError");
    expect(link).toContain("XeroContactCreateInProgressError");
    expect(link).toContain("XeroMemberUnavailableError");
    expect(deletion).toContain("XeroContactCreateBlocksDeletionError");
    expect(deletion).toContain("deletionCleanupRecovery");
  });
});
