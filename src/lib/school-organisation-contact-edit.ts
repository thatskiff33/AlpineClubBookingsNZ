/**
 * AN OFFICER CORRECTS A SCHOOL'S OWN EMAIL ADDRESS AND PHONE NUMBER (#5245).
 *
 * Since #3367 a school that books is a record of its own with its own Xero
 * contact, and its email and phone were written once, when the record was
 * created. This is the one in-app way to correct them. Decided on the issue:
 *
 * - **Only the school's own two fields.** Its name is not editable here (it is
 *   its Xero contact's name, which #3367 never rewrites), and neither are its
 *   teachers (an approval reconciles those).
 * - **A later booking request never changes them.** The club's record of a
 *   school outranks what one request typed; the officer corrects it here.
 * - **Live, not snapshotted.** Emails addressed to the school read
 *   `Organisation.email` through `bookingOwner`, and the next Xero send reads the
 *   record fresh, so what was already sent is not rewritten and what is sent
 *   next uses the correction.
 *
 * ## Concurrency (`INV-LOCK-002`)
 *
 * One transaction under the organisation's Xero contact key — the key the
 * contact resolve's link write takes — so an edit and a link never interleave
 * and the re-read of `xeroContactId` below is the one that commits. Two
 * officers cannot overwrite each other: the save names the `updatedAt` the
 * officer's screen loaded and is a guarded claim on it, so the second save
 * finds the row moved and is refused as a conflict, writing nothing.
 */
import { z } from "zod";

import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { lockOrganisationXeroContact } from "@/lib/organisation-xero-contacts";
import {
  enqueueOrganisationContactDetailsOperation,
  findLatestOrganisationContactDetailsOperation,
} from "@/lib/organisation-xero-contact-details";

const noLineBreaks = (value: string) => !/[\r\n]/.test(value);

/**
 * The two fields as an officer types them. Trimmed; an empty value clears the
 * field. The limits are the columns' and the request-correction form's.
 */
export const schoolContactDetailsSchema = z.object({
  email: z
    .string()
    .trim()
    .max(200)
    .refine(
      (value) => value === "" || z.string().email().safeParse(value).success,
      "Invalid email address",
    ),
  phone: z
    .string()
    .max(30)
    .refine(noLineBreaks, "Phone number cannot contain line breaks")
    .transform((value) => value.trim()),
});

export class SchoolContactEditError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "SchoolContactEditError";
  }
}

export const SCHOOL_CONTACT_CONFLICT_MESSAGE =
  "Someone else changed this school's details after you opened them. Reload to see the current details.";

export type SchoolContactEditResult = {
  changed: boolean;
  email: string | null;
  phone: string | null;
  updatedAt: Date;
  /** The Xero row queued for this edit; null when nothing changed or the school has no Xero contact yet. */
  queueOperationId: string | null;
};

export async function updateSchoolOrganisationContact(input: {
  organisationId: string;
  email: string;
  phone: string;
  expectedUpdatedAt: Date;
  actorId: string;
}): Promise<SchoolContactEditResult> {
  const details = schoolContactDetailsSchema.parse({
    email: input.email,
    phone: input.phone,
  });
  const email = details.email || null;
  const phone = details.phone || null;

  return prisma.$transaction(async (tx) => {
    await lockOrganisationXeroContact(tx, input.organisationId);

    const current = await tx.organisation.findUnique({
      where: { id: input.organisationId },
      select: { email: true, phone: true, updatedAt: true, archivedAt: true },
    });
    if (!current || current.archivedAt) {
      throw new SchoolContactEditError("School not found.", 404);
    }
    if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new SchoolContactEditError(SCHOOL_CONTACT_CONFLICT_MESSAGE, 409);
    }
    if (current.email === email && current.phone === phone) {
      return {
        changed: false,
        email,
        phone,
        updatedAt: current.updatedAt,
        queueOperationId: null,
      };
    }

    const claimed = await tx.organisation.updateMany({
      where: {
        id: input.organisationId,
        updatedAt: input.expectedUpdatedAt,
        archivedAt: null,
      },
      // The version always moves, by a millisecond at least. `@updatedAt` is
      // the app's clock, so two saves inside one millisecond would otherwise
      // leave the token unchanged and the second officer's save would pass.
      data: {
        email,
        phone,
        updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
      },
    });
    if (claimed.count !== 1) {
      throw new SchoolContactEditError(SCHOOL_CONTACT_CONFLICT_MESSAGE, 409);
    }
    // Re-read under the lock: the Xero link is the one that commits with this.
    const saved = await tx.organisation.findUniqueOrThrow({
      where: { id: input.organisationId },
      select: { updatedAt: true, xeroContactId: true },
    });

    await createAuditLog(
      {
        action: "organisation.contact_details.updated",
        memberId: input.actorId,
        actorMemberId: input.actorId,
        targetId: input.organisationId,
        entityType: "Organisation",
        entityId: input.organisationId,
        category: "booking",
        severity: "important",
        outcome: "success",
        summary: "School contact details corrected by officer",
        metadata: {
          previousEmail: current.email,
          previousPhone: current.phone,
          email,
          phone,
          xeroContactLinked: Boolean(saved.xeroContactId),
        },
      },
      tx,
    );

    const queued = saved.xeroContactId
      ? await enqueueOrganisationContactDetailsOperation(tx, {
          organisationId: input.organisationId,
          version: saved.updatedAt,
          createdByMemberId: input.actorId,
        })
      : null;

    return {
      changed: true,
      email,
      phone,
      updatedAt: saved.updatedAt,
      queueOperationId: queued?.id ?? null,
    };
  });
}

/** What the officer's editor loads: the details, their version, and the latest Xero row. */
export async function readSchoolOrganisationContact(organisationId: string) {
  const organisation = await prisma.organisation.findUnique({
    where: { id: organisationId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      updatedAt: true,
      archivedAt: true,
      xeroContactId: true,
    },
  });
  if (!organisation || organisation.archivedAt) return null;
  const latest = await findLatestOrganisationContactDetailsOperation(organisationId);
  return {
    id: organisation.id,
    name: organisation.name,
    email: organisation.email,
    phone: organisation.phone,
    updatedAt: organisation.updatedAt,
    hasXeroContact: Boolean(organisation.xeroContactId),
    xeroSync: latest
      ? {
          operationId: latest.id,
          status: latest.status,
          lastErrorMessage: latest.lastErrorMessage,
          queuedAt: latest.createdAt,
          completedAt: latest.completedAt,
        }
      : null,
  };
}
