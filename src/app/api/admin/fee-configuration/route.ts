import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AgeTier, type MembershipFeeBillingBasis, type Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import {
  FeeScheduleValidationError,
  MEMBERSHIP_FEE_BILLING_BASES,
  MEMBERSHIP_FEE_PRORATION_RULES,
  getFamilyBillingMode,
  lockFeeSchedule,
  scheduleOverlapWhere,
  serializeFeeSchedule,
  validateFeeComponents,
  validateFeeScheduleInput,
  type FeeComponentInput,
} from "@/lib/authoritative-fees";
import { prisma } from "@/lib/prisma";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { requireAdmin } from "@/lib/session-guards";
import { clubFormatValues } from "@/lib/club-format-server";
import type { ClubFormat } from "@/lib/club-format";

// A joining-fee row keys on membership type x optional age tier; the flat
// (NULL) tier is the whole-type fee (used by the Family type).
const JOINING_FEE_AGE_TIERS = ["INFANT", "CHILD", "YOUTH", "ADULT"] as const;
const joiningFeeAgeTier = z.enum(JOINING_FEE_AGE_TIERS).nullable();

const dateField = z.string().trim();
const moneyField = z.number().int().min(0).max(2_147_483_647);
const scheduleDates = {
  amountCents: moneyField,
  effectiveFrom: dateField,
  effectiveTo: dateField.nullable().optional(),
};
// A component (#1932, E6) is one Xero invoice line of an annual fee. Supplying
// `components` replaces the fee's components atomically (add/edit/remove/reorder);
// they must sum to the fee amount (validateFeeComponents). Editing a fee's amount
// REQUIRES supplying reconciled components in the same request.
const componentInput = z.object({
  label: z.string().trim().min(1).max(200),
  amountCents: moneyField,
  prorate: z.boolean(),
  xeroAccountCode: z.string().trim().max(50).nullable().optional(),
  xeroItemCode: z.string().trim().max(50).nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000),
});
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CREATE_MEMBERSHIP_FEE"),
    membershipTypeId: z.string().min(1),
    // Per-age-tier annual fees (#2067) reuse the joining-fee tier enum (which
    // already excludes NOT_APPLICABLE — decision 5). Optional/absent means the
    // flat NULL-tier row, so a pre-#2067 client that omits it still creates a
    // flat fee. PER_FAMILY + a tier is rejected below (decision 1).
    ageTier: joiningFeeAgeTier.optional(),
    billingBasis: z.enum(MEMBERSHIP_FEE_BILLING_BASES),
    prorationRule: z.enum(MEMBERSHIP_FEE_PRORATION_RULES),
    components: z.array(componentInput).max(50).optional(),
    ...scheduleDates,
  }).strict(),
  z.object({
    action: z.literal("UPDATE_MEMBERSHIP_FEE"),
    id: z.string().min(1),
    billingBasis: z.enum(MEMBERSHIP_FEE_BILLING_BASES),
    prorationRule: z.enum(MEMBERSHIP_FEE_PRORATION_RULES),
    components: z.array(componentInput).max(50).optional(),
    ...scheduleDates,
  }).strict(),
  z.object({ action: z.literal("DELETE_MEMBERSHIP_FEE"), id: z.string().min(1) }).strict(),
  z.object({
    action: z.literal("CREATE_JOINING_FEE"),
    membershipTypeId: z.string().min(1),
    ageTier: joiningFeeAgeTier,
    ...scheduleDates,
  }).strict(),
  z.object({
    action: z.literal("UPDATE_JOINING_FEE"),
    id: z.string().min(1),
    ...scheduleDates,
  }).strict(),
  z.object({ action: z.literal("DELETE_JOINING_FEE"), id: z.string().min(1) }).strict(),
  z.object({
    action: z.literal("SET_FAMILY_BILLING_MEMBER"),
    familyGroupId: z.string().min(1),
    billingMemberId: z.string().min(1).nullable(),
  }).strict(),
  // Per-member billing family (#1932, E6): which family's PER_FAMILY fee covers a
  // member who belongs to more than one. Consulted only in family-billing mode.
  z.object({
    action: z.literal("SET_MEMBER_BILLING_FAMILY"),
    memberId: z.string().min(1),
    billingFamilyGroupId: z.string().min(1).nullable(),
  }).strict(),
]);

// Reconcile an annual fee's components in the same transaction that writes the
// fee (#1932, E6). Upholds the component lifecycle invariant: CREATE auto-creates
// the default component (or copies a same-amount predecessor's components); an
// amount/no-invoice edit is REJECTED unless reconciled components are supplied;
// supplying components replaces them atomically (add/edit/remove/reorder). Every
// path validates Sigma components == fee amount before committing.
async function reconcileMembershipFeeComponents(args: {
  tx: Prisma.TransactionClient;
  fee: { id: string };
  existing: { id: string; amountCents: number; billingBasis: MembershipFeeBillingBasis } | null;
  membershipTypeId: string;
  ageTier: AgeTier | null;
  suppliedComponents?: FeeComponentInput[];
  newAmountCents: number;
  billingBasis: MembershipFeeBillingBasis;
  format: ClubFormat;
}) {
  const { tx, fee, existing, membershipTypeId, ageTier, suppliedComponents, newAmountCents, billingBasis, format } = args;

  const replaceWith = async (components: FeeComponentInput[]) => {
    validateFeeComponents({ components, amountCents: newAmountCents, billingBasis }, format);
    if (components.length === 0) return;
    await tx.membershipAnnualFeeComponent.createMany({
      data: components.map((component, index) => ({
        membershipAnnualFeeId: fee.id,
        label: component.label.trim(),
        amountCents: component.amountCents,
        prorate: component.prorate,
        xeroAccountCode: component.xeroAccountCode?.trim() || null,
        xeroItemCode: component.xeroItemCode?.trim() || null,
        sortOrder: component.sortOrder ?? index,
      })),
    });
  };

  if (existing) {
    const amountChanged = newAmountCents !== existing.amountCents;
    const crossesNoInvoice = (billingBasis === "NO_INVOICE") !== (existing.billingBasis === "NO_INVOICE");
    if (suppliedComponents) {
      await tx.membershipAnnualFeeComponent.deleteMany({ where: { membershipAnnualFeeId: fee.id } });
      await replaceWith(suppliedComponents);
      return;
    }
    if (amountChanged || crossesNoInvoice) {
      throw new FeeScheduleValidationError(
        "Editing the fee amount (or switching its no-invoice status) requires reconciling its components in the same request.",
      );
    }
    return; // amount + no-invoice status unchanged: keep the existing components
  }

  // CREATE: explicit components win, else copy a same-amount predecessor's
  // components (carry the club's structure forward across effective-dated rows),
  // else the single default component. NO_INVOICE creates none.
  if (suppliedComponents) {
    await replaceWith(suppliedComponents);
    return;
  }
  // Scope the predecessor to the SAME age tier (#2067): a new Youth fee copies a
  // prior Youth fee's component structure, never an Adult or flat fee's.
  const predecessor = billingBasis === "NO_INVOICE"
    ? null
    : await tx.membershipAnnualFee.findFirst({
        where: { membershipTypeId, ageTier, id: { not: fee.id } },
        orderBy: { effectiveFrom: "desc" },
        include: { components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
      });
  if (predecessor && predecessor.components.length > 0 && predecessor.amountCents === newAmountCents) {
    await replaceWith(predecessor.components.map((component) => ({
      label: component.label,
      amountCents: component.amountCents,
      prorate: component.prorate,
      xeroAccountCode: component.xeroAccountCode,
      xeroItemCode: component.xeroItemCode,
      sortOrder: component.sortOrder,
    })));
    return;
  }
  await replaceWith(
    billingBasis === "NO_INVOICE"
      ? []
      : [{ label: "Annual membership fee", amountCents: newAmountCents, prorate: true, xeroAccountCode: null, xeroItemCode: null, sortOrder: 0 }],
  );
}

async function loadConfiguration(canEdit: boolean) {
  const [familyBillingMode, membershipTypes, familyGroups, subscriptionIncomeMapping] = await Promise.all([
    getFamilyBillingMode(),
    prisma.membershipType.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true, key: true, name: true, isActive: true,
        annualFees: {
          orderBy: [{ ageTier: "asc" }, { effectiveFrom: "desc" }],
          include: { components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
        },
        joiningFees: { orderBy: [{ ageTier: "asc" }, { effectiveFrom: "desc" }] },
      },
    }),
    prisma.familyGroup.findMany({
      where: { memberships: { some: {} } },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, name: true, billingMembershipId: true,
        billingMembership: {
          select: {
            familyGroupId: true,
            member: { select: { id: true, firstName: true, lastName: true, email: true, active: true, archivedAt: true } },
          },
        },
        memberships: {
          where: { member: { archivedAt: null } },
          select: { member: { select: { id: true, firstName: true, lastName: true, email: true, active: true, ageTier: true } } },
          orderBy: { member: { firstName: "asc" } },
        },
      },
    }),
    // Resolve the annual-fee invoice line's default income account so the editor
    // can surface it (code + name) when a component leaves Account empty (#2068).
    // The invoice build REFUSES to bill unless subscriptionIncome is EXPLICITLY
    // configured (MISSING_XERO_ACCOUNT_MAPPING; see membership-subscription-billing),
    // so the editor must only advertise an explicitly-configured code — never the
    // hard-coded "203" fallback, which billing would not honour (F1).
    getResolvedAccountMapping("subscriptionIncome"),
  ]);
  // Family-billing exceptions only exist when the club bills families via a
  // nominated billing member. When it bills members individually the whole
  // family-billing surface is irrelevant, so no family is ever flagged.
  const familyBillingActive = familyBillingMode === "BILL_FAMILY_VIA_BILLING_MEMBER";
  return {
    canEdit,
    familyBillingMode,
    // The EXPLICITLY-configured default income account code for empty component
    // Account fields (#2068); the client pairs it with the account name from the
    // live chart of accounts. Null when subscriptionIncome is not explicitly
    // configured — the invoice build would refuse to bill, so the editor
    // advertises no default rather than the hard-coded "203" fallback (F1).
    defaultInvoiceAccountCode: subscriptionIncomeMapping.codeExplicitlyConfigured
      ? subscriptionIncomeMapping.code
      : null,
    membershipTypes: membershipTypes.map((type) => ({
      ...type,
      annualFees: type.annualFees.map((fee) => ({
        ...serializeFeeSchedule(fee),
        ageTier: fee.ageTier,
        components: fee.components.map((component) => ({
          id: component.id,
          label: component.label,
          amountCents: component.amountCents,
          prorate: component.prorate,
          xeroAccountCode: component.xeroAccountCode,
          xeroItemCode: component.xeroItemCode,
          sortOrder: component.sortOrder,
        })),
      })),
      joiningFees: type.joiningFees.map((fee) => ({
        ...serializeFeeSchedule(fee),
        ageTier: fee.ageTier,
      })),
    })),
    familyGroups: familyGroups.map((group) => ({
      ...group,
      billingMemberId: group.billingMembership?.member.id ?? null,
      billingException: familyBillingActive && (group.billingMembership == null
        || group.billingMembership.familyGroupId !== group.id
        || !group.billingMembership.member.active
        || group.billingMembership.member.archivedAt != null),
      billingMembership: undefined,
      billingMembershipId: undefined,
      members: group.memberships.map(({ member }) => member),
      memberships: undefined,
    })),
  };
}

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  return NextResponse.json(await loadConfiguration(
    hasAdminAreaAccess(guard.session.user, { area: "finance", level: "edit" }),
  ));
}

export async function POST(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  try {
    await prisma.$transaction(async (tx) => {
      const input = parsed.data;
      let targetId: string;
      if (input.action === "CREATE_MEMBERSHIP_FEE" || input.action === "UPDATE_MEMBERSHIP_FEE") {
        // Server-side mode gate: per-family billing is only meaningful when the
        // club bills families via a nominated billing member. The UI hides the
        // option, but this guard makes the rule authoritative against direct API
        // calls and cannot be bypassed.
        // A concurrent FAMILY->INDIVIDUALLY flip between this mode read and the
        // commit is backstopped by the billing engine's
        // `PER_FAMILY_FEE_IN_INDIVIDUAL_MODE` preview exception (a stale
        // PER_FAMILY schedule is never invoiced), so the guard need not serialise
        // against the settings row.
        if (input.billingBasis === "PER_FAMILY" && await getFamilyBillingMode(tx) === "BILL_MEMBERS_INDIVIDUALLY") {
          throw new FeeScheduleValidationError(
            "Per-family billing is disabled while this club bills members individually. Change the family billing mode on the subscription billing settings first.",
            409,
          );
        }
        const dates = validateFeeScheduleInput(input);
        const existing = input.action === "UPDATE_MEMBERSHIP_FEE"
          ? await tx.membershipAnnualFee.findUnique({ where: { id: input.id } })
          : null;
        if (input.action === "UPDATE_MEMBERSHIP_FEE" && !existing) throw new FeeScheduleValidationError("Membership fee not found.", 404);
        const membershipTypeId = input.action === "CREATE_MEMBERSHIP_FEE" ? input.membershipTypeId : existing!.membershipTypeId;
        // The tier is fixed at create and immutable on edit (joining-fee parity):
        // an update inherits the row's own tier. A flat fee is the NULL tier.
        const ageTier: AgeTier | null = input.action === "CREATE_MEMBERSHIP_FEE" ? (input.ageTier ?? null) : existing!.ageTier;
        // Decision 1 (#2067): per-tier rows are allowed only for PER_MEMBER /
        // NO_INVOICE bases; a PER_FAMILY fee bills the family once regardless of
        // age, so it stays flat-only. Enforced here (409), by a DB CHECK, and at
        // config-transfer plan time.
        if (input.billingBasis === "PER_FAMILY" && ageTier !== null) {
          throw new FeeScheduleValidationError(
            "Per-family fees apply to the whole membership type and cannot be set per age tier. Choose Flat (all ages) for a per-family fee.",
            409,
          );
        }
        if (!await tx.membershipType.findUnique({ where: { id: membershipTypeId }, select: { id: true } })) {
          throw new FeeScheduleValidationError("Membership type not found.", 404);
        }
        // Keep the TYPE-level lock (not tier-level): it serialises every write for
        // the type so the same-tier overlap check AND the cross-tier PER_FAMILY-mix
        // check below both see a consistent snapshot.
        await lockFeeSchedule(tx, "membership", membershipTypeId);
        const overlap = await tx.membershipAnnualFee.findFirst({
          where: { membershipTypeId, ageTier, ...scheduleOverlapWhere({ ...dates, excludeId: existing?.id }) }, select: { id: true },
        });
        if (overlap) throw new FeeScheduleValidationError("This membership fee overlaps an existing effective-date range.", 409);
        // Decision 1 (#2067): a flat PER_FAMILY fee and per-age-tier fees cannot
        // both be active for one type in overlapping windows — a tiered member
        // would resolve the per-member tier row while a flat-only member resolves
        // the per-family row, an ambiguous mix. Block either direction.
        const mixWhere: Prisma.MembershipAnnualFeeWhereInput | null =
          ageTier === null && input.billingBasis === "PER_FAMILY"
            ? { ageTier: { not: null } } // writing flat PER_FAMILY vs any per-tier row
            : ageTier !== null
              ? { ageTier: null, billingBasis: "PER_FAMILY" } // writing a per-tier row vs a flat PER_FAMILY row
              : null;
        if (mixWhere) {
          const mix = await tx.membershipAnnualFee.findFirst({
            where: { membershipTypeId, ...mixWhere, ...scheduleOverlapWhere({ ...dates, excludeId: existing?.id }) },
            select: { id: true },
          });
          if (mix) throw new FeeScheduleValidationError(
            "A per-family (flat) fee and per-age-tier fees cannot both be active for this membership type in overlapping windows. Use one pricing model per window.",
            409,
          );
        }
        const row = existing
          ? await tx.membershipAnnualFee.update({ where: { id: existing.id }, data: { ...dates, billingBasis: input.billingBasis, prorationRule: input.prorationRule } })
          : await tx.membershipAnnualFee.create({ data: { membershipTypeId, ageTier, ...dates, billingBasis: input.billingBasis, prorationRule: input.prorationRule } });
        targetId = row.id;
        await reconcileMembershipFeeComponents({
          tx,
          fee: row,
          existing,
          membershipTypeId,
          ageTier,
          suppliedComponents: input.components,
          newAmountCents: dates.amountCents,
          billingBasis: input.billingBasis,
          format,
        });
      } else if (input.action === "CREATE_JOINING_FEE" || input.action === "UPDATE_JOINING_FEE") {
        const dates = validateFeeScheduleInput(input);
        const existing = input.action === "UPDATE_JOINING_FEE"
          ? await tx.joiningFee.findUnique({ where: { id: input.id } })
          : null;
        if (input.action === "UPDATE_JOINING_FEE" && !existing) throw new FeeScheduleValidationError("Joining fee not found.", 404);
        const membershipTypeId = input.action === "CREATE_JOINING_FEE" ? input.membershipTypeId : existing!.membershipTypeId;
        const ageTier: AgeTier | null = input.action === "CREATE_JOINING_FEE" ? input.ageTier : existing!.ageTier;
        if (input.action === "CREATE_JOINING_FEE"
          && !await tx.membershipType.findUnique({ where: { id: membershipTypeId }, select: { id: true } })) {
          throw new FeeScheduleValidationError("Membership type not found.", 404);
        }
        const tierKey = `${membershipTypeId}:${ageTier ?? "FLAT"}`;
        await lockFeeSchedule(tx, "joining", tierKey);
        const overlap = await tx.joiningFee.findFirst({
          where: { membershipTypeId, ageTier, ...scheduleOverlapWhere({ ...dates, excludeId: existing?.id }) }, select: { id: true },
        });
        if (overlap) throw new FeeScheduleValidationError("This joining fee overlaps an existing effective-date range.", 409);
        const row = existing
          ? await tx.joiningFee.update({ where: { id: existing.id }, data: dates })
          : await tx.joiningFee.create({ data: { membershipTypeId, ageTier, ...dates } });
        targetId = row.id;
      } else if (input.action === "DELETE_MEMBERSHIP_FEE") {
        const existing = await tx.membershipAnnualFee.findUnique({ where: { id: input.id } });
        if (!existing) throw new FeeScheduleValidationError("Membership fee not found.", 404);
        await lockFeeSchedule(tx, "membership", existing.membershipTypeId);
        await tx.membershipAnnualFee.delete({ where: { id: existing.id } });
        targetId = existing.id;
      } else if (input.action === "DELETE_JOINING_FEE") {
        const existing = await tx.joiningFee.findUnique({ where: { id: input.id } });
        if (!existing) throw new FeeScheduleValidationError("Joining fee not found.", 404);
        await lockFeeSchedule(tx, "joining", `${existing.membershipTypeId}:${existing.ageTier ?? "FLAT"}`);
        await tx.joiningFee.delete({ where: { id: existing.id } });
        targetId = existing.id;
      } else if (input.action === "SET_FAMILY_BILLING_MEMBER") {
        const group = await tx.familyGroup.findUnique({ where: { id: input.familyGroupId }, select: { id: true } });
        if (!group) throw new FeeScheduleValidationError("Family group not found.", 404);
        if (input.billingMemberId) {
          const membership = await tx.familyGroupMember.findUnique({
            where: { familyGroupId_memberId: { familyGroupId: input.familyGroupId, memberId: input.billingMemberId } },
            select: { id: true, member: { select: { active: true, archivedAt: true } } },
          });
          if (!membership || !membership.member.active || membership.member.archivedAt) {
            throw new FeeScheduleValidationError("Billing member must be an active, unarchived member of this family.");
          }
          await tx.familyGroup.update({ where: { id: input.familyGroupId }, data: { billingMembershipId: membership.id } });
        } else {
          await tx.familyGroup.update({ where: { id: input.familyGroupId }, data: { billingMembershipId: null } });
        }
        targetId = input.familyGroupId;
      } else {
        // SET_MEMBER_BILLING_FAMILY (#1932, E6): the chosen group must be one of
        // the member's families, so a selection can never point outside them.
        const member = await tx.member.findUnique({ where: { id: input.memberId }, select: { id: true } });
        if (!member) throw new FeeScheduleValidationError("Member not found.", 404);
        if (input.billingFamilyGroupId) {
          const membership = await tx.familyGroupMember.findUnique({
            where: { familyGroupId_memberId: { familyGroupId: input.billingFamilyGroupId, memberId: input.memberId } },
            select: { id: true },
          });
          if (!membership) {
            throw new FeeScheduleValidationError("The billing family must be one of the member's own family groups.");
          }
        }
        await tx.member.update({ where: { id: input.memberId }, data: { billingFamilyGroupId: input.billingFamilyGroupId } });
        targetId = input.memberId;
      }
      // `payment` (#2581): fee configuration IS money configuration, and
      // `payment` is `support` plus `finance` — the narrowest genuine gate for
      // it. `admin`, the only alternative that would keep the row off the
      // member timeline, reads with `support:view` ALONE, so it would widen the
      // Diagnostics side to buy the member side.
      //
      // THE ONE PLACE IN #2581 CHILD 2 WHERE A CLASSIFICATION PUBLISHES A ROW
      // TO SOMEBODY OTHER THAN THE ACTING ADMINISTRATOR. The
      // `SET_MEMBER_BILLING_FAMILY` branch above sets `targetId =
      // input.memberId`, and `buildMemberAuditLogWhere`'s `targetId` leg is what
      // the member self-timeline matches on — so from here that member sees this
      // row about their own billing-family selection. None of the other seven
      // actions can: they write a membership-fee, joining-fee or family-group id.
      //
      // What the member gets, checked against `serializeAuditTimelineLog`:
      // `details` is a JSON object, so it comes back `null` with `description:
      // null`; `metadata`, `requestId`, `ipAddress`, `userAgent` and
      // `retentionClass` are member-suppressed; `drilldowns` is empty. What they
      // DO get is the actor — rendered "Club admin" only when that person's
      // legacy `Member.role` is `ADMIN`; a scoped Finance Manager is rendered by
      // name, exactly as on every row the member can already see. Accepted: the
      // row is about the member's own billing arrangement, and the alternative
      // costs more than it buys.
      await createAuditLog({
        action: `fee-configuration.${parsed.data.action.toLowerCase()}`,
        category: "payment",
        memberId: guard.session.user.id,
        targetId,
        details: JSON.stringify(parsed.data),
      }, tx);
    });
    revalidatePath("/", "layout");
    return NextResponse.json(await loadConfiguration(true));
  } catch (error) {
    if (error instanceof FeeScheduleValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to update fee configuration." }, { status: 500 });
  }
}
