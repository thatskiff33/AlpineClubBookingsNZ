import type { AgeTier } from "@prisma/client";
import { prisma } from "./prisma";
import {
  computeAgeTierWithSettings,
  getAgeTierSettings,
  getSeasonStartCalendarDate,
} from "./age-tier";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "./club-time-zone-runtime";
import { clubSeasonYear } from "./financial-year";
import { dateOfBirthPrefilterBoundForMinAge } from "./date-of-birth-prefilter";
import {
  sendAgeUpInvitationEmail,
  sendAgeUpParentEmailHandoffEmail,
} from "./email";
import logger from "./logger";
import { createStructuredAuditLog } from "./audit";
import { issueActionToken } from "./action-tokens";
import { triggerMemberXeroContactGroupSync } from "./xero-contact-groups";
import { reconcileEmailInheritanceForMemberChange } from "@/lib/member-email-inheritance";
import { resolveInheritedEmailSourceId } from "@/lib/member-parent-links";

const AGE_UP_PARENT_EMAIL_HANDOFF_AUDIT_ACTION =
  "member.age_up.parent_email_handoff_sent";

type AgeUpUpgradeResult = {
  token: string;
  tokenHash: string;
  previousAgeTier: AgeTier;
  previousInheritEmailFromId: string | null;
  previousInheritEmailChoiceId: string | null;
  previousInheritParentEmail: boolean;
};

async function rollbackAgeUpUpgrade(
  memberId: string,
  upgrade: Pick<
    AgeUpUpgradeResult,
    | "tokenHash"
    | "previousAgeTier"
    | "previousInheritEmailFromId"
    | "previousInheritEmailChoiceId"
    | "previousInheritParentEmail"
  >
) {
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({
      where: {
        memberId,
        tokenHash: upgrade.tokenHash,
        used: false,
      },
    });

    await tx.member.updateMany({
      where: {
        id: memberId,
        canLogin: true,
        ageTier: "ADULT",
      },
      data: {
        canLogin: false,
        ageTier: upgrade.previousAgeTier,
        inheritEmailFromId: upgrade.previousInheritEmailFromId,
        // #2716: the CHOICE is part of what a rollback has to put back. Without
        // it the compensating write would restore the pointer beside an empty
        // choice, and the next reconciliation would clear the pointer again —
        // so a failed age-up email would silently cost the member the mailbox
        // the rollback exists to preserve.
        inheritEmailChoiceId: upgrade.previousInheritEmailChoiceId,
        inheritParentEmail: upgrade.previousInheritParentEmail,
      },
    });
    // The aged-up member's dependants were re-resolved through them when the
    // upgrade landed; putting the member back a tier has to put those pointers
    // back too, and reconciliation does it from the same rule rather than by
    // replaying a remembered list.
    await reconcileEmailInheritanceForMemberChange(tx, [memberId], {
      // A compensating age-DOWN after a failed age-up email: a system-origin
      // lifecycle transition, no human actor to claim (#2822).
      trigger: "lifecycle-eligibility-change",
    });
  });
}

type EmailHandoffSource = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
};

type AgeUpCandidate = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  parentMemberId: string | null;
  inheritEmailChoiceId: string | null;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
  inheritEmailFrom: EmailHandoffSource | null;
  parent: EmailHandoffSource | null;
};

type AgeUpParentEmailHandoffReason =
  | "inheritEmailFrom"
  | "legacyParentEmail"
  | "sharedLoginEmail";

type AgeUpParentEmailHandoff = {
  reason: AgeUpParentEmailHandoffReason;
  recipientEmail: string;
  recipientName: string;
  sourceMemberId: string | null;
};

function memberFullName(member: Pick<AgeUpCandidate, "firstName" | "lastName">) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
}

function sourceFullName(source: EmailHandoffSource | null | undefined) {
  if (!source) return "there";
  return (
    [source.firstName, source.lastName].filter(Boolean).join(" ").trim() ||
    "there"
  );
}

async function resolveAgeUpParentEmailHandoff(
  member: AgeUpCandidate
): Promise<AgeUpParentEmailHandoff | null> {
  if (member.inheritEmailFromId) {
    return {
      reason: "inheritEmailFrom",
      recipientEmail: member.inheritEmailFrom?.email ?? member.email,
      recipientName: sourceFullName(member.inheritEmailFrom),
      sourceMemberId: member.inheritEmailFromId,
    };
  }

  // #2716: a live CHOICE with no pointer means the club decided who receives
  // this member's mail and that person currently cannot. Falling through to
  // `member.email` here would send the age-up notice to a stale copy of the
  // chosen member's old address. Declining lets the shared-login fallback below
  // have its chance, and if that finds nobody the member is simply not aged up
  // — which is the visible-gap failure direction this issue chose.
  if (member.inheritEmailChoiceId) return null;

  if (member.inheritParentEmail && member.parentMemberId) {
    // #2282: RESOLVED, not read one hop. This branch used to mail
    // `member.parent.email` outright. That was safe only while a parent link
    // implied an active adult — the rule this issue removed — so it could now
    // hand a youth's age-up notice to a 16-year-old parent, to an archived
    // member, or to a club-internal placeholder address that `sendEmail` drops
    // or that hard-bounces. The same walk every WRITE path uses answers who the
    // family's contact of record actually is, and when it answers "nobody" this
    // branch declines rather than mailing an address nobody reads: the
    // shared-login fallback below is then given its chance.
    const { sourceId } = await resolveInheritedEmailSourceId(
      prisma,
      member.parentMemberId,
    );
    if (sourceId) {
      const source =
        sourceId === member.parentMemberId
          ? member.parent
          : await prisma.member.findUnique({
              where: { id: sourceId },
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
              },
            });
      if (source) {
        return {
          reason: "legacyParentEmail",
          recipientEmail: source.email,
          recipientName: sourceFullName(source),
          sourceMemberId: source.id,
        };
      }
    }
  }

  const sharedLoginMember = await prisma.member.findFirst({
    where: {
      id: { not: member.id },
      email: member.email,
      canLogin: true,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  });

  if (!sharedLoginMember) {
    return null;
  }

  return {
    reason: "sharedLoginEmail",
    recipientEmail: sharedLoginMember.email,
    recipientName: sourceFullName(sharedLoginMember),
    sourceMemberId: sharedLoginMember.id,
  };
}

async function hasAgeUpParentEmailHandoffAudit(memberId: string) {
  const existingHandoff = await prisma.auditLog.findFirst({
    where: {
      action: AGE_UP_PARENT_EMAIL_HANDOFF_AUDIT_ACTION,
      subjectMemberId: memberId,
      outcome: "success",
    },
    select: { id: true },
  });

  return Boolean(existingHandoff);
}

async function recordAgeUpParentEmailHandoffAudit(params: {
  member: AgeUpCandidate;
  handoff: AgeUpParentEmailHandoff;
  targetAgeTierLabel: string;
  targetAgeTierMinAge: number;
}) {
  const youthName = memberFullName(params.member);

  /*
    ROUTED THROUGH THE AUDIT BOUNDARY (#2581 review), not hand-built.

    This was the last production writer building its own
    `prisma.auditLog.create({ data: … })`. It already passed
    `category: "communication"`, so it looked settled — but a hand-built create
    skips `buildStructuredAuditLogCreateData` entirely, and that is where two
    things happen that this row needs:

     - RETENTION. `retentionClass` and `expiresAt` have no schema default and no
       Prisma middleware fills them, so the row was written NULL/NULL. That is
       the "kept forever" shape #2581 exists to remove: `pruneExpiredAuditLogs`
       carries `expiresAt: { lt: now }` on every branch and NULL is not less than
       anything, and `archiveEligibleAuditLogs` filters on `retentionClass`. The
       row is now `critical` — seven years — like every other `communication`
       row beside it.
     - SANITISATION. The metadata carries a recipient EMAIL ADDRESS. Nothing in
       this payload trips a redaction rule today, so the stored value does not
       change; what changes is that it is now subject to the same secret,
       card-number, depth, key-count and length limits as every other audit
       payload, instead of being written verbatim by construction.

    Everything else is deliberately identical: `createStructuredAuditLog`
    derives `targetId` from `subject.memberId`, so the row keeps the same
    `targetId`, `subjectMemberId`, `entityType`, `entityId`, `severity`,
    `outcome` and `summary` — which matters, because
    `hasAgeUpParentEmailHandoffAudit` dedupes on
    `action` + `subjectMemberId` + `outcome`.
  */
  await createStructuredAuditLog({
    action: AGE_UP_PARENT_EMAIL_HANDOFF_AUDIT_ACTION,
    subject: { memberId: params.member.id },
    entity: { type: "Member", id: params.member.id },
    category: "communication",
    severity: "info",
    outcome: "success",
    summary: `Age-up email handoff sent for ${youthName}`,
    metadata: {
      handoffReason: params.handoff.reason,
      recipientEmail: params.handoff.recipientEmail,
      sourceMemberId: params.handoff.sourceMemberId,
      targetAgeTier: "ADULT",
      targetAgeTierLabel: params.targetAgeTierLabel,
      targetAgeTierMinAge: params.targetAgeTierMinAge,
    },
  });
}

/**
 * Daily cron: detect members who have reached the configured ADULT age tier
 * at the season reference date and invite them to set up their own login.
 *
 * Criteria:
 *  - active: true
 *  - canLogin: false
 *  - ageTier: not ADULT
 *  - dateOfBirth indicates ADULT age tier at season start (April 1)
 *
 * For each qualifying member:
 *  1. Send a parent/source handoff if the member still shares a login email
 *  2. Otherwise update ageTier → ADULT, canLogin → true
 *  3. Create a password reset token (so they can set a password)
 *  4. Send age-up invitation email
 *  5. Roll back the upgrade/token if email delivery fails so the next run can retry
 *
 * Idempotency: members who already have canLogin=true are excluded.
 * EmailLog deduplication: we check for a prior "age-up-invitation" email to
 * the same member to avoid re-sending if the cron runs multiple times.
 */
export async function checkAgeUpMembers(): Promise<{
  processed: number;
  upgraded: number;
  handoff: number;
  skipped: number;
  failed: number;
}> {
  const seasonYear = clubSeasonYear(await readClubTimeZoneOutsideRequest());
  // ONE season-start calendar day for the prefilter AND the authority (#3082).
  // The bound below and `computeAgeTierWithSettings` further down used to read
  // two different frames off the same value; they now read the same day.
  const seasonStartDay = getSeasonStartCalendarDate(seasonYear);
  const seasonStart = dateOnlyInstantOf(seasonStartDay);
  const ageTierSettings = await getAgeTierSettings();
  const adultAgeTierSetting = ageTierSettings.find(
    (setting) => setting.tier === "ADULT"
  );
  const targetAgeTierLabel = adultAgeTierSetting?.label ?? "Adult (18+)";
  const targetAgeTierMinAge = adultAgeTierSetting?.minAge ?? 18;

  // Find non-login members whose DOB puts them in the ADULT tier on season start.
  // The bound comes from the configured ADULT minimum age and is EXACT since
  // #3082 — it admits precisely the members whose age reaches that minimum, not a
  // widened superset, because the bound and the authority below now read one
  // calendar frame. `dateOfBirthPrefilterBoundForMinAge` carries the whole
  // derivation and the three off-by-ones (#2859, #2872, #3082) that shaped it,
  // including why `computeAgeTierWithSettings` below — not this query — remains
  // the authority on who is actually promoted.
  const cutoffWindowEnd = dateOfBirthPrefilterBoundForMinAge(
    seasonStartDay,
    targetAgeTierMinAge,
  );

  const candidates = await prisma.member.findMany({
    where: {
      active: true,
      canLogin: false,
      // NOT_APPLICABLE is the organisation/school tier (#1440): those
      // records have no age and must never be aged up, even if someone has
      // entered a date of birth on one.
      ageTier: { notIn: ["ADULT", "NOT_APPLICABLE"] },
      dateOfBirth: {
        not: null,
        lt: cutoffWindowEnd,
      },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      parentMemberId: true,
      inheritParentEmail: true,
      inheritEmailFromId: true,
      inheritEmailChoiceId: true,
      inheritEmailFrom: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
      parent: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
    },
  });

  let upgraded = 0;
  let handoff = 0;
  let skipped = 0;
  let failed = 0;

  for (const member of candidates) {
    let upgradeResult: AgeUpUpgradeResult | null = null;

    try {
      // Double-check the age tier (belt-and-suspenders with the DB query)
      if (!member.dateOfBirth) {
        skipped++;
        continue;
      }
      const computedAgeTier = computeAgeTierWithSettings(
        member.dateOfBirth,
        seasonStart,
        ageTierSettings
      );
      if (computedAgeTier !== "ADULT") {
        skipped++;
        continue;
      }

      const parentEmailHandoff = await resolveAgeUpParentEmailHandoff(member);
      if (parentEmailHandoff) {
        const alreadyHandedOff = await hasAgeUpParentEmailHandoffAudit(member.id);
        if (alreadyHandedOff) {
          skipped++;
          continue;
        }

        const handoffOutcome = await sendAgeUpParentEmailHandoffEmail(
          parentEmailHandoff.recipientEmail,
          {
            recipientName: parentEmailHandoff.recipientName,
            memberFirstName: member.firstName,
            memberLastName: member.lastName,
            targetAgeTier: "ADULT",
            targetAgeTierLabel,
            targetAgeTierMinAge,
          }
        );

        /*
          THE AUDIT ROW IS THE ONLY THING THAT STOPS THIS BEING ATTEMPTED AGAIN
          (#3035) — `hasAgeUpParentEmailHandoffAudit` above reads it. `sendEmail`
          returns rather than throws when it withholds, so writing the row
          unconditionally recorded a handoff that never happened and closed the
          door on ever asking the parent again.

          The confirmed-copy withhold DOES write the row, because that outcome is
          terminal: a copy is a copy until somebody re-declares it, and without
          the row an idle staging box would re-attempt this handoff on every run
          and write a new counted `SKIPPED_NON_PRODUCTION` row each pass — which
          is the number that tells a live club wrongly declared a copy from a
          genuine one (owner decision 1, 23 Aug 2026).
        */
        const handoffSent = handoffOutcome.status === "sent";
        const handoffTerminalHere =
          handoffOutcome.status === "withheld_for_environment" &&
          handoffOutcome.reason === "environment_non_production";

        if (handoffSent || handoffTerminalHere) {
          await recordAgeUpParentEmailHandoffAudit({
            member,
            handoff: parentEmailHandoff,
            targetAgeTierLabel,
            targetAgeTierMinAge,
          });
        }

        if (handoffSent) {
          handoff++;
          logger.info(
            {
              memberId: member.id,
              firstName: member.firstName,
              handoffReason: parentEmailHandoff.reason,
            },
            "Age-up: parent email handoff sent; member login not enabled"
          );
        } else {
          failed++;
          logger.error(
            {
              memberId: member.id,
              handoffReason: parentEmailHandoff.reason,
              outcome: handoffOutcome.status,
              reason:
                "reason" in handoffOutcome ? handoffOutcome.reason : undefined,
              willRetry: !handoffTerminalHere,
            },
            "Age-up: the parent email handoff was not transmitted, so nobody has been asked for this member's own address"
          );
        }
        continue;
      }

      // Check if we already sent an age-up email to this member
      const alreadySent = await prisma.emailLog.findFirst({
        where: {
          to: member.email,
          templateName: "age-up-invitation",
          status: { in: ["SENT", "QUEUED"] },
        },
      });
      if (alreadySent) {
        skipped++;
        continue;
      }

      upgradeResult = await prisma.$transaction(async (tx) => {
        const currentMember = await tx.member.findUnique({
          where: { id: member.id },
          select: {
            canLogin: true,
            ageTier: true,
            inheritEmailFromId: true,
            inheritEmailChoiceId: true,
            inheritParentEmail: true,
            parentMemberId: true,
          },
        });
        if (
          !currentMember ||
          currentMember.canLogin ||
          currentMember.ageTier === "ADULT" ||
          // #2106 (MINOR-7): a member concurrently flipped to age-exempt (N/A)
          // must never be aged-up over — N/A is not a real person tier, so
          // re-check it inside the transaction alongside the ADULT short-circuit.
          currentMember.ageTier === "NOT_APPLICABLE" ||
          currentMember.inheritEmailFromId ||
          currentMember.inheritEmailChoiceId ||
          // #2716: the CHOICE counts as inheriting, and after this issue it is
          // the state that matters most. INV-LIFE-036 withholds a login from a
          // member whose email is inherited, and before the two-column split
          // "inherited" was exactly `inheritEmailFromId != null`. It is not any
          // more: a null pointer beside a live choice is the NORMAL state of a
          // member who is still inheriting and whose source has temporarily gone
          // unreachable. Testing the pointer alone let such a member age up,
          // take a login, and have the invitation sent to whatever stale copy
          // sat in their own `email` column.
          (currentMember.inheritParentEmail && currentMember.parentMemberId)
        ) {
          return null;
        }

        await tx.member.update({
          where: { id: member.id },
          data: {
            canLogin: true,
            ageTier: "ADULT",
            inheritEmailFromId: null,
            // #2716: the choice clears with the pointer. The member now has an
            // address and a login of their own, so the decision that routed
            // their mail to a parent is spent — and leaving it would have the
            // reconciliation below hand the pointer straight back.
            inheritEmailChoiceId: null,
            inheritParentEmail: false,
          },
        });

        // #2716: age-up is one of the events that moves a member across the
        // line between "can receive mail" and "cannot" — in the helpful
        // direction, for once. Until this moment they were a non-login minor
        // with no address of their own, so any dependant who had chosen them as
        // their contact of record resolved to nobody. Now they qualify, and
        // those pointers must follow.
        //
        // This replaces a bespoke sweep that had to GUESS which dependants came
        // through this member, because the only record was a flat pointer plus
        // `inheritParentEmail` — a flag that says "derived" but cannot say
        // "derived from whom", and that carries DEFAULT true besides. The old
        // code approximated the answer with "does the pointer name this member
        // or one of their own ancestors", and was careful to say why a wrong
        // guess would silently move a family's contact of record.
        //
        // The choice column removes the guess. A dependant is re-resolved
        // exactly when they NAMED this member, so a child with two parents whose
        // choice is the other parent is untouched — not because the heuristic
        // happens to miss them, but because the question is now answerable.
        await reconcileEmailInheritanceForMemberChange(tx, [member.id], {
          // The scheduled age-up crossing the ADULT line: a system-origin
          // lifecycle transition, no human actor (#2822).
          trigger: "lifecycle-eligibility-change",
        });

        const { token, tokenHash } = issueActionToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await tx.passwordResetToken.create({
          data: {
            tokenHash,
            memberId: member.id,
            expiresAt,
          },
        });

        return {
          token,
          tokenHash,
          previousAgeTier: currentMember.ageTier,
          previousInheritEmailFromId: currentMember.inheritEmailFromId,
          previousInheritEmailChoiceId: currentMember.inheritEmailChoiceId,
          previousInheritParentEmail: currentMember.inheritParentEmail,
        };
      });
      if (!upgradeResult) {
        skipped++;
        continue;
      }

      // Send invitation email (fire-and-forget style within the loop)
      const invitation = await sendAgeUpInvitationEmail(
        member.email,
        member.firstName,
        upgradeResult.token,
        {
          targetAgeTier: "ADULT",
          targetAgeTierLabel,
          targetAgeTierMinAge,
        }
      );

      /*
        A WITHHELD INVITATION IS ROLLED BACK, because the tier flip and the token
        are already committed and nothing else will ever finish the job (#3035).

        `sendEmail` RETURNS rather than throws when nothing was transmitted, so the
        `catch` below never fired for any of these and `upgradeResult = null`
        disarmed the rollback unconditionally. The member became an adult with a
        login and no invitation — and it is permanent: the `alreadySent` guard
        above only matches `SENT`/`QUEUED` rows so it does not stop a retry, but
        the transaction's own re-check sees `canLogin: true` and `ageTier: ADULT`
        and returns null, so every later run counts them as skipped. Nobody is
        ever told they now have a login, and the reset token expires in a week.

        Rolling back puts them back a tier with their inherited mailbox intact
        (`rollbackAgeUpUpgrade` restores the choice column too), so the next run
        tries again cleanly once an operator has fixed the configuration.

        THE CONFIRMED COPY IS THE EXCEPTION and keeps the upgrade: that outcome is
        terminal, and rolling back would have a staging box age the same member up
        and down on every run, writing a new counted `SKIPPED_NON_PRODUCTION` row
        each pass. That count is what distinguishes a live club wrongly declared a
        copy from an idle one (owner decision 1, 23 Aug 2026), so an idle copy must
        not manufacture it.
      */
      const invited = invitation.status === "sent";
      const invitationTerminalHere =
        invitation.status === "withheld_for_environment" &&
        invitation.reason === "environment_non_production";

      if (!invited && !invitationTerminalHere) {
        await rollbackAgeUpUpgrade(member.id, upgradeResult);
        upgradeResult = null;
        failed++;
        logger.error(
          {
            memberId: member.id,
            outcome: invitation.status,
            reason: "reason" in invitation ? invitation.reason : undefined,
          },
          "Age-up: the invitation was not transmitted, so the upgrade was rolled back and a later run will retry it"
        );
        continue;
      }

      upgradeResult = null;

      upgraded++;
      if (invited) {
        logger.info(
          { memberId: member.id, firstName: member.firstName },
          "Age-up: member upgraded to ADULT with login"
        );
      } else {
        logger.warn(
          { memberId: member.id, firstName: member.firstName },
          "Age-up: member upgraded to ADULT with login, but this installation is a copy so the invitation was held back and will not be retried"
        );
      }

      // Best-effort Xero contact-group re-sync after the tier flip (E8, #1934).
      // Non-fatal and idempotent on re-run; a no-op unless grouping is enabled
      // and the member has a Xero contact. Without this, a cron-aged member
      // would stay in their old age-tier group under Type+Age until some other
      // touch. Runs after the flip has durably committed, outside any DB tx.
      await triggerMemberXeroContactGroupSync(member.id, {
        reason: "cron_age_up",
      });
    } catch (err) {
      if (upgradeResult) {
        try {
          await rollbackAgeUpUpgrade(member.id, upgradeResult);
        } catch (rollbackErr) {
          logger.error(
            { err: rollbackErr, memberId: member.id },
            "Age-up: failed to roll back member upgrade after email failure"
          );
        }
      }

      failed++;
      logger.error(
        { err, memberId: member.id },
        "Age-up: failed to process member"
      );
    }
  }

  return {
    processed: candidates.length,
    upgraded,
    handoff,
    skipped,
    failed,
  };
}
