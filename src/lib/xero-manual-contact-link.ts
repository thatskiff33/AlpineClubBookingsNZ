import type { PrismaClient } from "@prisma/client";

import logger from "@/lib/logger";
import { buildXeroContactUrl } from "@/lib/xero-links";
import {
  closeProviderCreatedContactRecoveryForLinkedContact,
  lockMemberForManualXeroContactLink,
} from "@/lib/xero-contact-create-recovery";
import { prisma } from "@/lib/prisma";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import {
  assertXeroContactHasNoOtherHome,
  lockXeroContactHome,
} from "@/lib/xero-contact-home";

/**
 * Commit the Member pointer and its FK-less canonical CONTACT ledger row under
 * one exact target-Member FOR UPDATE fence. Provider lookup/cache work belongs
 * outside this helper and outside the transaction.
 */
export async function commitManualXeroContactLink(
  input: {
    memberId: string;
    xeroContactId: string;
    contactName: string | null;
  },
  db: PrismaClient = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    // INV-INT-018 (#3367): an administrator typing a contact id is the other
    // way a member can end up claiming a Xero customer an ORGANISATION already
    // owns — a school's contact is in the same Xero contact list the admin picks
    // from. Refuse and say which organisation holds it, rather than leaving two
    // local records pointing at one customer.
    //
    // THE CONTACT-HOME KEY COMES BEFORE THE MEMBER ROW FENCE (INV-LOCK-002).
    // The organisation-side transfer takes a Member ROW lock while holding this
    // key, so a writer that held the row and then waited for the key would close
    // a deadlock cycle with it. Taking the key first means every participant
    // reaches a Member row only with the contact key already held.
    await lockXeroContactHome(tx, input.xeroContactId);
    await lockMemberForManualXeroContactLink(tx, input.memberId);
    await assertXeroContactHasNoOtherHome(tx, {
      xeroContactId: input.xeroContactId,
      home: { kind: "MEMBER", id: input.memberId },
    });
    await tx.member.update({
      where: { id: input.memberId },
      data: { xeroContactId: input.xeroContactId },
    });
    // `XeroObjectLink.localId` has no FK. Keeping this write in the same
    // transaction prevents merge from deleting the loser between the pointer
    // update and ledger upsert.
    await upsertXeroObjectLink(
      {
        localModel: "Member",
        localId: input.memberId,
        xeroObjectType: "CONTACT",
        xeroObjectId: input.xeroContactId,
        xeroObjectUrl: buildXeroContactUrl(input.xeroContactId),
        role: "CONTACT",
        metadata: {
          contactName: input.contactName,
          linkedManually: true,
        },
      },
      { store: tx },
    );

    // #2623 T7: manual linking IS the documented remedy for a create whose Xero
    // contact exists but whose local link failed. Closing that operation here —
    // under the same Member fence, and only when its own recorded contact is the
    // one just linked — stops a successfully recovered member from blocking
    // member merge and account deletion indefinitely while their detail page
    // reports a clean Xero state.
    const closed = await closeProviderCreatedContactRecoveryForLinkedContact(
      tx,
      input.memberId,
      input.xeroContactId,
    );
    if (closed.closedCount > 0) {
      logger.info(
        {
          memberId: input.memberId,
          xeroContactId: input.xeroContactId,
          operationIds: closed.operationIds,
          closedCount: closed.closedCount,
        },
        "Closed provider-created Xero contact-create recovery on manual link",
      );
    }
  });
}
