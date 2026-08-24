// Club-agnostic first-run seed. Every section is create-if-missing: re-running
// the seed against a populated database must never delete, overwrite, or
// duplicate data. Clubs customise the placeholders through the admin screens.
import { type AgeTier, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { clubConfig } from "../src/config/club";
import {
  CLUB_CONTACT_EMAIL,
  clubDomainEmail,
} from "../src/config/club-identity";
import { CLUB_TIME_SETTINGS_ID } from "../src/lib/club-time-zone";
import { requireClubTimeZone } from "../src/lib/club-time";
import { clubSeasonYear } from "../src/lib/financial-year";
import { decideClubTimeZoneBackfill } from "../src/lib/config-self-heal-steps";
import { slugifyLodgeName } from "../src/lib/lodges";
import { CLUB_CONFIG_LODGE_CAPACITY } from "../src/lib/lodge-capacity";
import {
  CLUB_THEME_ID,
  DEFAULT_CLUB_THEME_VALUES,
} from "../src/lib/club-theme-schema";
import { DEFAULT_INDUCTION_TEMPLATE } from "../src/lib/induction-checklist-template";
import { DEFAULT_FINANCE_REPORT_CATEGORIES } from "../src/lib/finance-report-mapping-defaults";
import {
  backfillCurrentSeasonMembershipAssignments,
} from "../src/lib/membership-types";
import { ensureAccessRoleDefinitions } from "../src/lib/access-role-definitions";
import { ensureBuiltInDisplays } from "../src/lib/lodge-display/built-in-seeds";
import { ensureMemberAccessRolesFromCompatibilityFields } from "../src/lib/member-access-role-writes";
import { ensureDefaultSeasonSubscriptionForNewMember } from "../src/lib/member-subscription-defaults";
import { createPrismaPgAdapter } from "../src/lib/prisma-adapter";
import {
  buildSeedAdminMemberData,
  buildSeedChoreTemplates,
  buildSeedCommitteeRoles,
  buildSeedLodgeMemberData,
} from "./seed-data";
import { starterPageContent } from "./starter-page-content";
import { starterSiteContent } from "./starter-site-content";

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(),
});

type InductionChecklistTemplateDelegate = {
  findFirst: (args: {
    where: { version: string };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
  count: (args: { where: { isActive: true } }) => Promise<number>;
  create: (args: {
    data: {
      name: string;
      version: string;
      kind: "NEW_MEMBER" | "HUT_LEADER" | "YOUTH_TO_FULL" | "RE_INDUCTION";
      sourceLabel: string | null;
      isActive: boolean;
      sections: {
        create: Array<{
          title: string;
          description: string | null;
          priority:
            | "EMERGENCY"
            | "SECURITY"
            | "STARTUP"
            | "SHUTDOWN"
            | "GENERAL";
          sortOrder: number;
          items: {
            create: Array<{
              label: string;
              competencyPrompt: string | null;
              notesPrompt: string | null;
              isMandatory: boolean;
              requiresDemonstration: boolean;
              sortOrder: number;
              legacySourceText: string | null;
            }>;
          };
        }>;
      };
    };
  }) => Promise<unknown>;
};

function inductionChecklistTemplateDelegate(): InductionChecklistTemplateDelegate {
  // Some local type-generation states can temporarily miss this delegate even
  // though the model exists in schema and database. Keep seed typing resilient.
  return (
    prisma as unknown as {
      inductionChecklistTemplate: InductionChecklistTemplateDelegate;
    }
  ).inductionChecklistTemplate;
}

function seedRatesForSeason(season: "winter" | "summer") {
  return clubConfig.ageTiers.flatMap((tier) => [
    {
      ageTier: tier.id as AgeTier,
      isMember: true,
      pricePerNightCents: tier.nightlyRates[season].memberCents,
    },
    {
      ageTier: tier.id as AgeTier,
      isMember: false,
      pricePerNightCents: tier.nightlyRates[season].nonMemberCents,
    },
  ]);
}

function seedAgeTierSettings() {
  return clubConfig.ageTiers.map((tier, sortOrder) => ({
    tier: tier.id as AgeTier,
    minAge: tier.minAge,
    maxAge: tier.maxAge,
    label: tier.label,
    subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
    familyGroupRequestCreateMemberAllowed:
      tier.familyGroupRequestCreateMemberAllowed,
    sortOrder,
  }));
}

function requireSeedEnv(
  name: "SEED_ADMIN_EMAIL" | "SEED_ADMIN_PASSWORD" | "SEED_LODGE_PASSWORD",
) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required before running prisma/seed.ts`);
  }
  return value;
}

// #2190 P4 — the public seed provisions ONLY the generic default site style.
// A fork's own brand palette lives in its deployment's ClubTheme DB row and is
// provisioned by that fork's own seed override, not by public-repo code
// (standing directive D15 — no fork/Tokoroa colours in the public repo).
//
// SEED_THEME_COMPLETE=1 stamps the DEFAULT palette's setup COMPLETE (completedAt)
// so the public site renders its real header/footer/title chrome — used by E2E
// and staging where the club-identity smoke asserts on that chrome. It is
// palette-free: it seeds no colours and no logo, only the completion timestamp
// (the default palette is already seeded on the row). It replaces the removed,
// colour-bearing fork-seed path.
async function seedClubTheme() {
  const markComplete = process.env.SEED_THEME_COMPLETE === "1";
  await prisma.clubTheme.upsert({
    where: { id: CLUB_THEME_ID },
    update: markComplete ? { completedAt: new Date() } : {},
    create: {
      id: CLUB_THEME_ID,
      ...DEFAULT_CLUB_THEME_VALUES,
      completedAt: markComplete ? new Date() : null,
    },
  });
  console.log(
    markComplete
      ? "Default site style seeded and marked complete"
      : "Default site style seeded",
  );
}

// Seed the membership-type-keyed hut rates (#1930, E4) with the same D4 fan-out
// the migration backfill uses: member rates -> every MEMBER_RATE type,
// non-member rates -> the built-in NON_MEMBER type. Create-if-missing so admin
// edits survive a re-run. Every type starts age-keyed (ageGroupsApply=true).
async function createMissingMembershipTypeSeasonRates(
  seasonId: string,
  season: "winter" | "summer",
) {
  const types = await prisma.membershipType.findMany({
    select: { id: true, key: true, bookingBehavior: true },
  });
  const rates = seedRatesForSeason(season);
  const memberRates = rates.filter((rate) => rate.isMember);
  const nonMemberRates = rates.filter((rate) => !rate.isMember);

  const upsert = async (
    membershipTypeId: string,
    ageTier: AgeTier,
    pricePerNightCents: number,
  ) => {
    await prisma.membershipTypeSeasonRate.upsert({
      where: {
        seasonId_membershipTypeId_ageTier: {
          seasonId,
          membershipTypeId,
          ageTier,
        },
      },
      update: {},
      create: { seasonId, membershipTypeId, ageTier, pricePerNightCents },
    });
  };

  for (const type of types) {
    if (type.bookingBehavior === "MEMBER_RATE") {
      for (const rate of memberRates) {
        await upsert(type.id, rate.ageTier, rate.pricePerNightCents);
      }
    } else if (type.key === "NON_MEMBER") {
      for (const rate of nonMemberRates) {
        await upsert(type.id, rate.ageTier, rate.pricePerNightCents);
      }
    }
    // NON_MEMBER_RATE (except NON_MEMBER) and BLOCK_BOOKING types deliberately
    // get no own rows (D2 invariant).
  }
}

// Seed the default Lodge Induction checklist template (create-if-missing). The
// template is only created when no template with this version exists, so admin
// edits and new versions survive a re-run. It is marked active only when no
// other active template is present.
async function seedInductionChecklistTemplate() {
  const inductionChecklistTemplate = inductionChecklistTemplateDelegate();

  const existing = await inductionChecklistTemplate.findFirst({
    where: { version: DEFAULT_INDUCTION_TEMPLATE.version },
    select: { id: true },
  });
  if (existing) {
    console.log("Induction checklist template already present; skipping");
    return;
  }

  const activeCount = await inductionChecklistTemplate.count({
    where: { isActive: true },
  });

  await inductionChecklistTemplate.create({
    data: {
      name: DEFAULT_INDUCTION_TEMPLATE.name,
      version: DEFAULT_INDUCTION_TEMPLATE.version,
      kind: DEFAULT_INDUCTION_TEMPLATE.kind,
      sourceLabel: DEFAULT_INDUCTION_TEMPLATE.sourceLabel,
      isActive: activeCount === 0,
      sections: {
        create: DEFAULT_INDUCTION_TEMPLATE.sections.map(
          (section, sectionIndex) => ({
            title: section.title,
            description: section.description ?? null,
            priority: section.priority,
            sortOrder: sectionIndex,
            items: {
              create: section.items.map((item, itemIndex) => ({
                label: item.label,
                competencyPrompt: item.competencyPrompt ?? null,
                notesPrompt: item.notesPrompt ?? null,
                isMandatory: item.isMandatory ?? false,
                requiresDemonstration: item.requiresDemonstration ?? false,
                sortOrder: itemIndex,
                legacySourceText: item.legacySourceText ?? null,
              })),
            },
          }),
        ),
      },
    },
  });
  console.log(
    `Induction checklist template seeded: ${DEFAULT_INDUCTION_TEMPLATE.name} v${DEFAULT_INDUCTION_TEMPLATE.version}`,
  );
}

async function main() {
  console.log(
    "Seeding database (create-if-missing; re-runs change nothing)...",
  );

  const seedAdminEmail = requireSeedEnv("SEED_ADMIN_EMAIL").toLowerCase();
  const seedAdminPassword = requireSeedEnv("SEED_ADMIN_PASSWORD");

  // Ensure the club's lodge exists (create-if-missing). The migration that
  // introduced the Lodge table seeds a 'Lodge' placeholder row when
  // EmailMessageSetting has no configured lodge name; on a first-run seed,
  // upgrade that placeholder to the club-config lodge name. Rows with any
  // other name are club data and are never touched.
  // Derived default lodge name (the config-derived fallback that clubLodgeName
  // used to export before E3 #1929 made lodge identity DB-first). The seed still
  // names the placeholder lodge "<Club> Lodge"; NO geography/address is seeded
  // (the Lodge.address backfill lives in migration SQL only — the
  // seed-account-defaults guard keeps geography out of seeds).
  const clubLodgeName = `${clubConfig.name} Lodge`;
  const existingLodges = await prisma.lodge.findMany({
    select: { id: true, name: true },
    // Deterministic order so the else-branch below stamps the oldest lodge
    // (matching getDefaultLodgeId), not whatever the engine returns first.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
  });
  let seedLodgeId: string;
  if (existingLodges.length === 0) {
    const createdLodge = await prisma.lodge.create({
      data: {
        name: clubLodgeName,
        slug: slugifyLodgeName(clubLodgeName),
        active: true,
        // Flag the sole lodge as the club default (#1656). The migration
        // backfill already sets this on the migration-seeded lodge; this
        // branch only fires where no lodge exists yet (e.g. a db-push test
        // setup that skipped the migration INSERT), so the flag would
        // otherwise be missing and getDefaultLodgeId would fall back to
        // createdAt ordering.
        isDefault: true,
      },
    });
    seedLodgeId = createdLodge.id;
    console.log(`Lodge seeded: ${clubLodgeName}`);
  } else if (
    existingLodges.length === 1 &&
    existingLodges[0].name === "Lodge"
  ) {
    const updatedLodge = await prisma.lodge.update({
      where: { id: existingLodges[0].id },
      data: {
        name: clubLodgeName,
        slug: slugifyLodgeName(clubLodgeName),
      },
    });
    seedLodgeId = updatedLodge.id;
    console.log(`Lodge placeholder renamed to: ${clubLodgeName}`);
  } else {
    seedLodgeId = existingLodges[0].id;
  }

  // DB-first club identity singleton (E3 #1929): seed the club.json values so a
  // fresh install has a row, but CREATE-ONLY (update: {}) — a re-run must never
  // overwrite an admin's edits. An absent row is still fully functional via the
  // runtime fallback chain; this just makes the admin card show the config
  // values as the current values. No lodge name/address is stored here (lodge
  // identity is the Lodge table's; address is migration-only).
  await prisma.clubIdentitySettings.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      // Normalise identically to the self-heal step (currentFacebookUrl in
      // config-self-heal.ts): trim and collapse blank → null, so a seed-created
      // row and a boot-healed row hold byte-identical values (#1984).
      facebookUrl: clubConfig.socialLinks?.facebook?.trim() || null,
    },
  });
  console.log("Club identity settings seeded (create-only)");

  // DB-first club timezone singleton (CT-1 #2989): store the zone this
  // installation is EFFECTIVELY using so a freshly seeded database matches a
  // booted one (the #1984 parity standard) instead of having no stored zone until
  // first boot. CREATE-ONLY (update: {}) — a re-run must never overwrite the zone
  // an admin chose on the club time page or the setup wizard. Note this is the
  // CLUB's timezone, not the container's: once the row exists, moving TZ cannot
  // move the club's civil time.
  //
  // The value comes from `decideClubTimeZoneBackfill()`, which is the SAME
  // function the boot backfill (`clubTimeZoneSelfHealStep`) calls — so a
  // seed-created row and a boot-healed row hold byte-identical values by
  // construction rather than by two files agreeing to call the same resolver the
  // same way, which is what drifted before (#2989 review). Read its docblock for
  // why `TZ=GB` records Europe/London, and for why `TZ=UTC` records
  // Pacific/Auckland while saying so out loud (owner decision, 23 Aug 2026):
  // `UTC` is no place, so there was nothing to preserve and the club may be up to
  // thirteen hours from the zone it has just been given.
  const clubTimeZoneBackfill = decideClubTimeZoneBackfill();
  await prisma.clubTimeSettings.upsert({
    where: { id: CLUB_TIME_SETTINGS_ID },
    update: {},
    create: {
      id: CLUB_TIME_SETTINGS_ID,
      timeZone: clubTimeZoneBackfill.timeZone,
      // The seed has no admin session, like the boot backfill.
      updatedByMemberId: null,
    },
  });
  // The season the CLUB is in, from the zone this seed has just written rather than
  // from the host's month (CT-4 group F1, #2870), resolved ONCE here because three
  // seeded rows below need it and `ensureDefaultSeasonSubscriptionForNewMember`
  // requires it rather than defaulting — see its docblock. `clubTimeZoneBackfill` is
  // create-only, so the row is read back: on a re-seed the stored zone is the club's
  // real one and the freshly-decided value would be the environment's.
  const seededClubTimeZone = await prisma.clubTimeSettings.findUnique({
    where: { id: CLUB_TIME_SETTINGS_ID },
    select: { timeZone: true },
  });
  const seedClubSeasonYear = clubSeasonYear(
    requireClubTimeZone(
      seededClubTimeZone?.timeZone ?? clubTimeZoneBackfill.timeZone,
    ),
  );

  if (clubTimeZoneBackfill.kind === "defaulted") {
    console.log(
      `Club time settings seeded (create-only) as ` +
        `${clubTimeZoneBackfill.timeZone} BY DEFAULT: TZ / NEXT_PUBLIC_TZ is ` +
        `"${clubTimeZoneBackfill.raw}", which is not a named place such as ` +
        `Pacific/Auckland, so there was nothing to preserve. If this club is ` +
        `somewhere else, set the club's timezone at /admin/club-time (or run ` +
        `npm run setup); the setup checklist reports it as a warning until ` +
        `somebody confirms it.`,
    );
  } else {
    console.log(
      `Club time settings seeded (create-only): ${clubTimeZoneBackfill.timeZone}`,
    );
  }

  // DB-only lodge capacity parity (#1982): since #1982 removed the runtime
  // club.json capacity fallback, the default lodge's bookable capacity is the
  // DB `LodgeSettings.capacity` — normally backfilled by the boot-time config
  // self-heal (config-self-heal.ts). Seed it here too so a freshly seeded DB is
  // immediately bookable and matches a booted DB (the #1984 parity standard),
  // rather than resolving to 0 until first boot. Mirrors the self-heal step
  // exactly: the 20260627100000 migration INSERTs the "default" row with a NULL
  // capacity, so a bare create-only upsert would leave it null; the null-scoped
  // updateMany fills that migration null while NEVER overwriting an admin-set
  // value (or a re-run). A fresh seed configures no beds and Bed Allocation
  // defaults OFF, so the config bed total is the correct bookable value (the E1
  // gate reasoning: module off → no bed count to cap). Guarded value > 0; the
  // row is linked to the seeded default lodge so its capacity never leaks to an
  // additional lodge lacking its own row.
  if (Number.isFinite(CLUB_CONFIG_LODGE_CAPACITY) && CLUB_CONFIG_LODGE_CAPACITY > 0) {
    await prisma.lodgeSettings.upsert({
      where: { id: "default" },
      update: {},
      create: {
        id: "default",
        capacity: CLUB_CONFIG_LODGE_CAPACITY,
        lodgeId: seedLodgeId,
      },
    });
    await prisma.lodgeSettings.updateMany({
      where: { id: "default", capacity: null },
      data: { capacity: CLUB_CONFIG_LODGE_CAPACITY },
    });
    await prisma.lodgeSettings.updateMany({
      where: { id: "default", lodgeId: null },
      data: { lodgeId: seedLodgeId },
    });
    console.log("Default lodge capacity seeded (create-only, null-scoped fill)");
  }

  // Seed default cancellation policy tiers (create-if-missing).
  const policies = [
    { daysBeforeStay: 14, refundPercentage: 100 },
    { daysBeforeStay: 7, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ];

  for (const policy of policies) {
    // Tier uniqueness is per partition ([lodgeId, daysBeforeStay]) and the
    // club-wide partition is the null lodgeId, which a compound-unique
    // upsert cannot address — so create-if-missing by lookup instead.
    const existing = await prisma.cancellationPolicy.findFirst({
      where: { daysBeforeStay: policy.daysBeforeStay, lodgeId: null },
      select: { id: true },
    });
    if (!existing) {
      await prisma.cancellationPolicy.create({ data: policy });
    }
  }

  console.log("Cancellation policies seeded");

  // Seed example chore templates only when none exist yet, so re-runs never
  // resurrect templates an admin has deleted or renamed.
  const choreTemplateCount = await prisma.choreTemplate.count();
  if (choreTemplateCount === 0) {
    const choreTemplates = buildSeedChoreTemplates();
    for (const chore of choreTemplates) {
      await prisma.choreTemplate.create({
        data: { ...chore, lodgeId: seedLodgeId },
      });
    }
    console.log(
      `Chore templates seeded: ${choreTemplates.length} example templates`,
    );
  } else {
    console.log("Chore templates already present; skipping");
  }

  // Seed the editable access-role definitions (create-if-missing; club edits
  // are never overwritten) and re-link any enum-only assignment rows.
  await ensureAccessRoleDefinitions(prisma);

  // Seed the first admin account (only if no admin exists). canLogin and
  // emailVerified are required for the credentials login flow to accept the
  // account; forcePasswordChange routes the first login to /change-password.
  const existingAdmin = await prisma.member.findFirst({
    where: { role: "ADMIN" },
  });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(seedAdminPassword, 12);
    const admin = await prisma.member.create({
      data: buildSeedAdminMemberData({
        email: seedAdminEmail,
        passwordHash,
        firstName: process.env.SEED_ADMIN_FIRST_NAME,
        lastName: process.env.SEED_ADMIN_LAST_NAME,
      }),
    });
    // Admin accounts resolve to the NOT_REQUIRED built-in ADMIN type (#2149).
    await ensureDefaultSeasonSubscriptionForNewMember(
      prisma,
      admin,
      seedClubSeasonYear,
    );
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: admin.id,
      role: admin.role,
      financeAccessLevel: admin.financeAccessLevel,
      canLogin: admin.canLogin,
    });
    console.log(
      `Admin user seeded: ${seedAdminEmail} (password change required on first login)`,
    );
  } else {
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: existingAdmin.id,
      role: existingAdmin.role,
      financeAccessLevel: existingAdmin.financeAccessLevel,
      canLogin: existingAdmin.canLogin,
    });
  }

  // Seed the shared lodge kiosk account (create-if-missing).
  const lodgeAccountEmail = clubDomainEmail("lodge");
  const existingLodge = await prisma.member.findFirst({
    where: { email: lodgeAccountEmail },
  });

  if (!existingLodge) {
    const lodgePasswordHash = await bcrypt.hash(
      requireSeedEnv("SEED_LODGE_PASSWORD"),
      12,
    );
    const lodge = await prisma.member.create({
      data: buildSeedLodgeMemberData({
        email: lodgeAccountEmail,
        passwordHash: lodgePasswordHash,
      }),
    });
    await ensureDefaultSeasonSubscriptionForNewMember(
      prisma,
      lodge,
      seedClubSeasonYear,
    );
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: lodge.id,
      role: lodge.role,
      financeAccessLevel: lodge.financeAccessLevel,
      canLogin: lodge.canLogin,
    });
    console.log(`Lodge account seeded: ${lodgeAccountEmail}`);
  } else {
    await ensureMemberAccessRolesFromCompatibilityFields(prisma, {
      memberId: existingLodge.id,
      role: existingLodge.role,
      financeAccessLevel: existingLodge.financeAccessLevel,
      canLogin: existingLodge.canLogin,
    });
  }

  const membershipAssignmentBackfill =
    await backfillCurrentSeasonMembershipAssignments(prisma, seedClubSeasonYear);
  console.log(
    `Membership types seeded; current-season assignments created: ${membershipAssignmentBackfill.createdCount}`,
  );

  // Seed Winter 2026 season (June - September) with rates from club config.
  const winter2026 = await prisma.season.upsert({
    where: { id: "seed-winter-2026" },
    update: {},
    create: {
      id: "seed-winter-2026",
      name: "Winter 2026",
      type: "WINTER",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-09-30"),
      active: true,
      lodgeId: seedLodgeId,
    },
  });
  await createMissingMembershipTypeSeasonRates(winter2026.id, "winter");
  console.log(`Season seeded: ${winter2026.name}`);

  // Seed Summer 2026-27 season (November - March) with rates from club config.
  const summer2026 = await prisma.season.upsert({
    where: { id: "seed-summer-2026" },
    update: {},
    create: {
      id: "seed-summer-2026",
      name: "Summer 2026-27",
      type: "SUMMER",
      startDate: new Date("2026-11-01"),
      endDate: new Date("2027-03-31"),
      active: true,
      lodgeId: seedLodgeId,
    },
  });
  await createMissingMembershipTypeSeasonRates(summer2026.id, "summer");
  console.log(`Season seeded: ${summer2026.name}`);

  // Group-discount substitution target (#1930, E4): a GroupDiscountSetting row
  // created outside the re-key migration would carry a NULL target, leaving an
  // enabled discount inert but for the read-time fallback. Create-if-missing
  // (schema defaults keep the discount disabled) and heal a NULL target to the
  // built-in FULL type — never overwriting an admin-configured target.
  const fullMembershipType = await prisma.membershipType.findFirst({
    where: { key: "FULL" },
    select: { id: true },
  });
  if (fullMembershipType) {
    await prisma.groupDiscountSetting.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default", rateMembershipTypeId: fullMembershipType.id },
    });
    await prisma.groupDiscountSetting.updateMany({
      where: { id: "default", rateMembershipTypeId: null },
      data: { rateMembershipTypeId: fullMembershipType.id },
    });
    console.log("Group discount substitution target seeded");
  }

  // Seed Xero account mappings with current defaults (create-if-missing).
  const accountMappings = [
    { key: "hutFeesIncome", code: "200" },
    { key: "hutFeeRefunds", code: "200" },
    { key: "stripeBankAccount", code: "606" },
    { key: "stripeFees", code: null },
    { key: "subscriptionIncome", code: "203" },
    { key: "membershipCancellationCredit", code: "203" },
  ];
  for (const mapping of accountMappings) {
    await prisma.xeroAccountMapping.upsert({
      where: { key: mapping.key },
      update: {},
      create: mapping,
    });
  }
  console.log("Xero account mappings seeded");

  for (const category of DEFAULT_FINANCE_REPORT_CATEGORIES) {
    await prisma.financeReportCategory.upsert({
      where: {
        kind_name: {
          kind: category.kind,
          name: category.name,
        },
      },
      update: {},
      create: category,
    });
  }
  console.log("Finance report categories seeded");

  // Seed age tier settings from club config (create-if-missing so settings
  // edited by admins survive a re-run).
  const ageTierSettings = seedAgeTierSettings();
  for (const setting of ageTierSettings) {
    await prisma.ageTierSetting.upsert({
      where: { tier: setting.tier },
      update: {},
      create: setting,
      // Not a deployed-runtime path, but narrowed with the rest for
      // consistency (#2130): no caller reads the returned row.
      select: { tier: true },
    });
  }
  console.log("Age tier settings seeded");

  // Seed starter editable page content only when records do not yet exist.
  for (const page of starterPageContent) {
    await prisma.pageContent.upsert({
      where: { slug: page.slug },
      update: {},
      create: {
        slug: page.slug,
        path: page.path,
        caption: page.caption,
        menuTitle: page.menuTitle,
        title: page.title,
        headerText: page.headerText,
        sortOrder: page.sortOrder,
        contentHtml: page.contentHtml,
      },
    });
  }
  console.log(`Page content seeded: ${starterPageContent.length} pages`);

  // Seed starter site content (public footer columns) only when records do
  // not yet exist, so admin edits survive a re-run.
  for (const section of starterSiteContent) {
    await prisma.siteContent.upsert({
      where: { key: section.key },
      update: {},
      create: {
        id: section.id,
        key: section.key,
        contentHtml: section.contentHtml,
      },
    });
  }
  console.log(`Site content seeded: ${starterSiteContent.length} sections`);

  const committeeRoles = buildSeedCommitteeRoles({
    domainEmail: clubDomainEmail,
    contactEmail: CLUB_CONTACT_EMAIL,
  });
  for (const role of committeeRoles) {
    await prisma.committeeRole.upsert({
      where: { key: role.key },
      update: {},
      create: {
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        contactEmail: role.contactEmail,
        sortOrder: role.sortOrder,
      },
    });
  }
  console.log(`Committee master roles seeded: ${committeeRoles.length} roles`);

  await seedClubTheme();

  await seedInductionChecklistTemplate();

  // Seed the built-in lobby-display designs as v2 Layout + Template rows
  // (LTV-038). DELIBERATE EXCEPTION to this file's "never overwrite" contract
  // (see the header): the built-ins are code-managed scaffolding, so
  // `ensureBuiltInDisplays` upserts each by `key` and REFRESHES its definition
  // from code on every re-seed — shipped-design improvements reach already-seeded
  // installs (owner decision A, issue #111). Only the reserved `builtin-*` keys
  // are touched; an admin customises by DUPLICATING a built-in into a new
  // (non-built-in) row, so an in-place edit to a built-in is intentionally
  // overwritten here (the authoring editors warn + confirm before such an edit,
  // issue #156). Devices bind to these rows by `templateId`.
  await ensureBuiltInDisplays(prisma);
  console.log("Built-in display layouts/templates seeded");

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
