import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeAgeTier, getSeasonStartDate } from "@/lib/age-tier";
import { clubTimeZone } from "@/lib/club-time/server";
import { clubSeasonYear } from "@/lib/financial-year";
import { isXeroConnected } from "@/lib/xero-token-store";
import { syncManagedXeroContactGroupForMember } from "@/lib/xero-contact-groups";
import { updateXeroContact } from "@/lib/xero-contacts";
import {
  buildXeroContactUpdatePayload,
  hasMemberXeroContactChanges,
  shouldRepairXeroContactNameOrder,
} from "@/lib/xero-contact-sync";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { copyStreetAddressToPostal } from "@/lib/member-address";
import { parseDateOnly } from "@/lib/date-only";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { clubTime } from "@/lib/club-time/server";
import { evaluateSelfServiceProfilePayload } from "@/lib/member-profile-completeness";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { loadMemberFieldsFlags } from "@/lib/member-fields-settings";
import {
  hasAccessRole,
  isOrganisationMember,
  resolveAccessRoleTokens,
} from "@/lib/access-roles";
import {
  loadMemberCurrentSeasonTypeExemption,
  resolveEnforcedAgeTier,
} from "@/lib/age-tier-enforcement";
import { reconcileEmailInheritanceForMemberChange } from "@/lib/member-email-inheritance";
import {
  buildDietaryRequirementsPatch,
  dietaryRequirementsChanged,
  grantSelfDietaryAccess,
  readMemberDietaryRequirements,
} from "@/lib/member-dietary";
import { memberProfileUpdateSchema } from "@/lib/member-profile-update-schema";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE } from "@/lib/connection-shapes";

const PHONE_FIELDS = [
  "phoneCountryCode",
  "phoneAreaCode",
  "phoneNumber",
] as const;
const STREET_FIELDS = [
  "streetAddressLine1",
  "streetAddressLine2",
  "streetCity",
  "streetRegion",
  "streetPostalCode",
  "streetCountry",
] as const;
const POSTAL_FIELDS = [
  "postalAddressLine1",
  "postalAddressLine2",
  "postalCity",
  "postalRegion",
  "postalPostalCode",
  "postalCountry",
] as const;
const PROFILE_AUDIT_FIELDS = [
  "firstName",
  "lastName",
  ...PHONE_FIELDS,
  "dateOfBirth",
  "ageTier",
  ...STREET_FIELDS,
  ...POSTAL_FIELDS,
  "occupation",
  "lodgeScreenPhoneOptIn",
  "profileCompletedAt",
] as const;
const PROFILE_XERO_SYNC_SELECT = {
  id: true,
  canLogin: true,
  role: true,
  accessRoles: { select: { role: true } },
  firstName: true,
  lastName: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  dateOfBirth: true,
  ageTier: true,
  occupation: true,
  lodgeScreenPhoneOptIn: true,
  email: true,
  xeroContactId: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
  profileCompletedAt: true,
} as const;

function normalizeAuditValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value === undefined || value === "") {
    return null;
  }
  return value;
}

function getChangedFields(
  before: Record<string, unknown>,
  updateData: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => {
    if (!Object.prototype.hasOwnProperty.call(updateData, field)) {
      return false;
    }
    return (
      normalizeAuditValue(before[field]) !==
      normalizeAuditValue(updateData[field])
    );
  });
}

function hasAnyField(
  changedFields: readonly string[],
  fields: readonly string[],
): boolean {
  return fields.some((field) => changedFields.includes(field));
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = memberProfileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  }

  const data = parsed.data;

  const updateData: Record<string, unknown> = {
    firstName: data.firstName.trim(),
    lastName: data.lastName.trim(),
  };

  // Phone fields
  for (const f of PHONE_FIELDS) {
    updateData[f] = data[f]?.trim() || null;
  }

  // Address fields
  for (const f of [...STREET_FIELDS, ...POSTAL_FIELDS]) {
    if (data[f] !== undefined) {
      updateData[f] = data[f]?.trim() || null;
    }
  }

  // Date of birth. The age tier is resolved after loading the member below so
  // enforcement (org / FORCED-type force, and preserving an ALLOWED-type manual
  // N/A) is applied and a DOB recompute can never silently un-force N/A (#2106).
  const { dateOfBirth } = data;
  let dobProvided = false;
  if (dateOfBirth && dateOfBirth !== "") {
    const dob = parseDateOnly(dateOfBirth);
    if (isNaN(dob.getTime())) {
      return NextResponse.json(
        { error: "Invalid date of birth" },
        { status: 422 },
      );
    }
    // "In the future" means a later CLUB CALENDAR DAY, not a later instant
    // (#2682). `dob` is a date-only value at UTC midnight, so comparing it
    // against the raw clock refuses today's club date for the first ~12-13h of
    // every club day — which is exactly the date the form's own `max` offers.
    // `request-child/route.ts` and `create-group/route.ts` already compare
    // this way.
    // CT-4 (#2870): that day comes from the persisted ClubTimeSettings zone,
    // not the container's TZ (INV-CONFIG-002, INV-DATE-019).
    const today = dateOnlyInstantOf((await clubTime()).today());
    if (dob > today) {
      return NextResponse.json(
        { error: "Date of birth cannot be in the future" },
        { status: 422 },
      );
    }
    updateData.dateOfBirth = dob;
    dobProvided = true;
  } else if (dateOfBirth === "" || dateOfBirth === null) {
    updateData.dateOfBirth = null;
  }

  const existing = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: PROFILE_XERO_SYNC_SELECT,
  });
  if (!existing) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // Postal same as physical: copied from the street address as it will be
  // saved, sent fields over stored ones. The profile form sends every street
  // field; an AI app (ALP-718) may send the flag alone, which must copy the
  // stored street address rather than blank the postal one.
  if (data.postalSameAsPhysical) {
    const street = (field: (typeof STREET_FIELDS)[number]) =>
      (field in updateData ? updateData[field] : existing[field]) as string | null | undefined;
    const postalAddress = copyStreetAddressToPostal({
      streetAddressLine1: street("streetAddressLine1"),
      streetAddressLine2: street("streetAddressLine2"),
      streetCity: street("streetCity"),
      streetRegion: street("streetRegion"),
      streetPostalCode: street("streetPostalCode"),
      streetCountry: street("streetCountry"),
    });

    for (const field of POSTAL_FIELDS) {
      updateData[field] = postalAddress[field]?.trim() || null;
    }
  }

  // #2106: apply age-tier enforcement to a DOB change. Only touch the tier when
  // the member supplied a DOB (self-service edits never submit a tier directly).
  if (dobProvided) {
    // ONE season for both halves of this decision, from the club's PERSISTED zone
    // (CT-4, #2870): the tier the date of birth implies and the exemption that may
    // override it must be judged in the same season.
    const clubCurrentSeasonYear = clubSeasonYear(await clubTimeZone());
    const dobDerivedTier = await computeAgeTier(
      updateData.dateOfBirth as Date,
      getSeasonStartDate(clubCurrentSeasonYear),
    );
    const typeExemption = await loadMemberCurrentSeasonTypeExemption(
      prisma,
      session.user.id,
      clubCurrentSeasonYear,
    );
    const resolved = resolveEnforcedAgeTier({
      isOrganisation: isOrganisationMember({
        accessRoleTokens: resolveAccessRoleTokens(existing),
        legacyRole: existing.role,
      }),
      typeExemption,
      currentAgeTier: existing.ageTier,
      restorePersonTier: dobDerivedTier,
    });
    // resolveEnforcedAgeTier only errors on an explicit manual N/A request,
    // which self-service never sends, so this is always ok.
    if (resolved.ok) {
      updateData.ageTier = resolved.ageTier;
    }
  }

  // Occupation: adult-only and gated behind the admin showOccupation flag.
  // Use the freshly computed ageTier when DOB was supplied, otherwise the
  // member's existing ageTier. If not adult, the flag is off, or the field was
  // not sent, leave the stored occupation untouched: the profile form always
  // sends it, and an AI app saving other fields must not clear it (ALP-718).
  const flags = await loadMemberFieldsFlags();
  const effectiveAgeTier =
    (updateData.ageTier as string | undefined) ?? existing.ageTier;
  if (flags.showOccupation && effectiveAgeTier === "ADULT" && data.occupation !== undefined) {
    updateData.occupation = data.occupation?.trim() || null;
  }

  // Dietary/allergy information (#2941, INV-PRIV-022): any age tier, written
  // only while the club has the field ON and only when the form sent it. OFF
  // produces no patch, so the stored value survives untouched. The previous
  // value is read through the one dietary door purely to decide whether the
  // audit row names the field as changed; the value itself is never recorded.
  const dietaryPatch = buildDietaryRequirementsPatch({
    enabled: flags.showDietaryRequirements,
    value: data.dietaryRequirements,
  });
  const dietaryBefore =
    "dietaryRequirements" in dietaryPatch
      ? await readMemberDietaryRequirements(
          grantSelfDietaryAccess(session),
          session.user.id,
        )
      : null;
  Object.assign(updateData, dietaryPatch);

  // #126 / #37: the phone-display opt-in is a member's own privacy choice, so
  // accept it whenever supplied. It is only meaningful for adults (the
  // serialiser never releases a non-adult phone) but is harmless to store.
  if (data.lodgeScreenPhoneOptIn !== undefined) {
    updateData.lodgeScreenPhoneOptIn = data.lodgeScreenPhoneOptIn;
  }

  if (existing.canLogin && hasAccessRole(existing, "USER")) {
    // Judged on the record as it will be saved: what was sent over what is
    // stored. The profile form sends every field, so for it this is what was
    // sent; an AI app (ALP-718) may leave out a field it cannot read, such as
    // the date of birth, and that field is kept rather than read as missing.
    const saved = { ...existing, ...updateData };
    const profileCompleteness = evaluateSelfServiceProfilePayload({
      firstName: saved.firstName as string | null | undefined,
      lastName: saved.lastName as string | null | undefined,
      phoneCountryCode: saved.phoneCountryCode as string | null | undefined,
      phoneAreaCode: saved.phoneAreaCode as string | null | undefined,
      phoneNumber: saved.phoneNumber as string | null | undefined,
      dateOfBirth: saved.dateOfBirth as Date | null | undefined,
      streetAddressLine1: saved.streetAddressLine1 as string | null | undefined,
      streetAddressLine2: saved.streetAddressLine2 as string | null | undefined,
      streetCity: saved.streetCity as string | null | undefined,
      streetRegion: saved.streetRegion as string | null | undefined,
      streetPostalCode: saved.streetPostalCode as string | null | undefined,
      streetCountry: saved.streetCountry as string | null | undefined,
      postalAddressLine1: saved.postalAddressLine1 as string | null | undefined,
      postalAddressLine2: saved.postalAddressLine2 as string | null | undefined,
      postalCity: saved.postalCity as string | null | undefined,
      postalRegion: saved.postalRegion as string | null | undefined,
      postalPostalCode: saved.postalPostalCode as string | null | undefined,
      postalCountry: saved.postalCountry as string | null | undefined,
      postalSameAsPhysical: data.postalSameAsPhysical,
    });

    if (!profileCompleteness.isProfileComplete) {
      return NextResponse.json(
        {
          error: "Profile is incomplete",
          missingFields: profileCompleteness.missingFields,
        },
        { status: 422 },
      );
    }

    if (!existing.profileCompletedAt) {
      updateData.profileCompletedAt = new Date();
    }
  }

  try {
    const changedFields = getChangedFields(
      existing as unknown as Record<string, unknown>,
      updateData,
      PROFILE_AUDIT_FIELDS,
    );
    if (dietaryRequirementsChanged(dietaryBefore, dietaryPatch)) {
      changedFields.push("dietaryRequirements");
    }
    // #2821: an INTERACTIVE transaction rather than the batch array this used to
    // be. An age tier decides whether this member may be anybody's contact of
    // record (`isUsableEmailSource` requires ADULT), and a member correcting
    // their own date of birth here can move themselves across that line — which
    // has to re-resolve their dependants' pointers. A batch array cannot express
    // that, because there is no client to hand the reconciler; running it
    // afterwards would make the guarantee a best effort, which is what the
    // reconciler's docblock warns against. The two writes below are unchanged
    // and still commit atomically with each other.
    const updated = await prisma.$transaction(async (tx) => {
      const member = await tx.member.update({
        where: { id: session.user.id },
        data: updateData,
        select: PROFILE_XERO_SYNC_SELECT,
      });
      // `account`, and DELIBERATELY NOT joined to the `admin` unification that
      // #2755 applied to the three officer-driven member-record writers
      // (`INV-PRIV-012`). This route's actor IS its subject — `where: { id:
      // session.user.id }`, no on-behalf path — so it is a member editing their
      // own record, not an officer administering somebody else's. Same fields,
      // different business domain: self-service rather than administration.
      //
      // Filing it `admin` would hide a member's own action from their own
      // timeline, which is a narrowing in the one direction nobody argued for.
      // #2755's issue body listed this site as part of the split; it is not.
      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "member.profile.updated",
          actor: { memberId: session.user.id },
          subject: { memberId: session.user.id },
          entity: { type: "Member", id: session.user.id },
          category: "account",
          severity: "important",
          outcome: "success",
          summary: "Member profile updated",
          metadata: {
            changedFields,
            changedFieldCount: changedFields.length,
            fieldGroups: {
              name: hasAnyField(changedFields, ["firstName", "lastName"]),
              phone: hasAnyField(changedFields, PHONE_FIELDS),
              address: hasAnyField(changedFields, [
                ...STREET_FIELDS,
                ...POSTAL_FIELDS,
              ]),
              dateOfBirth: changedFields.includes("dateOfBirth"),
              ageTier: changedFields.includes("ageTier"),
              occupation: changedFields.includes("occupation"),
              dietaryRequirements: changedFields.includes("dietaryRequirements"),
              lodgeScreenPhoneOptIn: changedFields.includes(
                "lodgeScreenPhoneOptIn",
              ),
              profileCompleted: changedFields.includes("profileCompletedAt"),
            },
            postalSameAsPhysical: data.postalSameAsPhysical === true,
          },
          request: getAuditRequestContext(req),
        }),
      );
      await reconcileEmailInheritanceForMemberChange(tx, [session.user.id], {
        // A member editing their own record (address included): a direct
        // source-member change, actor is the member themselves (#2822).
        trigger: "source-member-change",
        actorMemberId: session.user.id,
      });
      return member;
    });

    const hasMappedContactUpdate = updated.xeroContactId
      ? hasMemberXeroContactChanges(existing, updated)
      : false;
    const shouldRepairContactNameOrder = updated.xeroContactId
      ? await shouldRepairXeroContactNameOrder(updated)
      : false;
    const needsContactUpdate = Boolean(
      updated.xeroContactId &&
      (hasMappedContactUpdate || shouldRepairContactNameOrder),
    );
    const needsContactGroupSync =
      updated.xeroContactId && existing.ageTier !== updated.ageTier;

    if (
      updated.xeroContactId &&
      (needsContactUpdate || needsContactGroupSync)
    ) {
      try {
        if (await isXeroConnected()) {
          if (needsContactUpdate) {
            await updateXeroContact(
              updated.xeroContactId,
              buildXeroContactUpdatePayload(updated),
              {
                localModel: "Member",
                localId: session.user.id,
                createdByMemberId: session.user.id,
                preserveXeroName: !shouldRepairContactNameOrder,
              },
            );
          }

          if (needsContactGroupSync) {
            await syncManagedXeroContactGroupForMember(session.user.id, {
              createdByMemberId: session.user.id,
            });
          }
        }
      } catch (xeroErr) {
        logger.error(
          { err: xeroErr, memberId: session.user.id },
          "Xero sync failed for profile update",
        );
      }
    }

    // ALP-718: a connection gets the `get_my_profile` fields, not the columns above.
    return connectionJson(req, updated, MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE);
  } catch {
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 },
    );
  }
}
