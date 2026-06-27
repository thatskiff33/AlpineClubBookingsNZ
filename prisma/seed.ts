// Club-agnostic first-run seed. Every section is create-if-missing: re-running
// the seed against a populated database must never delete, overwrite, or
// duplicate data. Clubs customise the placeholders through the admin screens.
import fs from "node:fs";
import path from "node:path";
import { type AgeTier, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { clubConfig } from "../src/config/club";
import {
  CLUB_CONTACT_EMAIL,
  clubDomainEmail,
} from "../src/config/club-identity";
import {
  CLUB_THEME_ID,
  DEFAULT_CLUB_THEME_VALUES,
  MAX_LOGO_DATA_URL_BYTES,
  TOKOROA_CLUB_THEME_VALUES,
  isValidLogoDataUrl,
} from "../src/lib/club-theme-schema";
import { DEFAULT_INDUCTION_TEMPLATE } from "../src/lib/induction-checklist-template";
import { DEFAULT_FINANCE_REPORT_CATEGORIES } from "../src/lib/finance-report-mapping-defaults";
import { ensureNotRequiredSubscriptionForRole } from "../src/lib/member-subscription-defaults";
import { createPrismaPgAdapter } from "../src/lib/prisma-adapter";
import {
  buildSeedAdminMemberData,
  buildSeedChoreTemplates,
  buildSeedCommitteePlaceholders,
  buildSeedLodgeMemberData,
  shouldSkipTokoroaThemeSeed,
} from "./seed-data";
import { starterPageContent } from "./starter-page-content";

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

function readBrandingLogoDataUrl() {
  const logoPath = path.join(process.cwd(), "public", "branding", "logo.png");
  if (!fs.existsSync(logoPath)) {
    return null;
  }

  const logo = fs.readFileSync(logoPath);
  if (logo.byteLength > MAX_LOGO_DATA_URL_BYTES) {
    throw new Error(
      `public/branding/logo.png is ${logo.byteLength} bytes; the site style logo cap is ${MAX_LOGO_DATA_URL_BYTES} bytes.`,
    );
  }

  const dataUrl = `data:image/png;base64,${logo.toString("base64")}`;
  if (!isValidLogoDataUrl(dataUrl)) {
    throw new Error(
      "public/branding/logo.png could not be converted to a valid logo data URL.",
    );
  }

  return dataUrl;
}

async function seedClubTheme() {
  if (process.env.SEED_TOKOROA_THEME_COMPLETE === "1") {
    const existing = await prisma.clubTheme.findUnique({
      where: { id: CLUB_THEME_ID },
      select: { completedAt: true },
    });
    if (shouldSkipTokoroaThemeSeed(existing)) {
      console.log(
        "Club theme setup already completed; skipping Tokoroa site style re-seed",
      );
      return;
    }

    const logoDataUrl = readBrandingLogoDataUrl();
    await prisma.clubTheme.upsert({
      where: { id: CLUB_THEME_ID },
      update: {
        ...TOKOROA_CLUB_THEME_VALUES,
        logoDataUrl,
        completedAt: new Date(),
      },
      create: {
        id: CLUB_THEME_ID,
        ...TOKOROA_CLUB_THEME_VALUES,
        logoDataUrl,
        completedAt: new Date(),
      },
    });
    console.log(
      logoDataUrl
        ? "Tokoroa site style seeded with palette and logo"
        : "Tokoroa site style seeded with palette; public/branding/logo.png was not present",
    );
    return;
  }

  await prisma.clubTheme.upsert({
    where: { id: CLUB_THEME_ID },
    update: {},
    create: {
      id: CLUB_THEME_ID,
      ...DEFAULT_CLUB_THEME_VALUES,
      completedAt: null,
    },
  });
  console.log("Default site style seeded");
}

// Create any missing per-tier rates for a season without touching existing
// rows, so rates edited by admins survive a re-run.
async function createMissingSeasonRates(
  seasonId: string,
  season: "winter" | "summer",
) {
  for (const rate of seedRatesForSeason(season)) {
    await prisma.seasonRate.upsert({
      where: {
        seasonId_ageTier_isMember: {
          seasonId,
          ageTier: rate.ageTier,
          isMember: rate.isMember,
        },
      },
      update: {},
      create: {
        seasonId,
        ...rate,
      },
    });
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

  // Seed default cancellation policy tiers (create-if-missing).
  const policies = [
    { daysBeforeStay: 14, refundPercentage: 100 },
    { daysBeforeStay: 7, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ];

  for (const policy of policies) {
    await prisma.cancellationPolicy.upsert({
      where: { daysBeforeStay: policy.daysBeforeStay },
      update: {},
      create: policy,
    });
  }

  console.log("Cancellation policies seeded");

  // Seed example chore templates only when none exist yet, so re-runs never
  // resurrect templates an admin has deleted or renamed.
  const choreTemplateCount = await prisma.choreTemplate.count();
  if (choreTemplateCount === 0) {
    const choreTemplates = buildSeedChoreTemplates();
    for (const chore of choreTemplates) {
      await prisma.choreTemplate.create({ data: chore });
    }
    console.log(
      `Chore templates seeded: ${choreTemplates.length} example templates`,
    );
  } else {
    console.log("Chore templates already present; skipping");
  }

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
    // Admin accounts never owe a membership subscription.
    await ensureNotRequiredSubscriptionForRole(prisma, admin);
    console.log(
      `Admin user seeded: ${seedAdminEmail} (password change required on first login)`,
    );
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
    await ensureNotRequiredSubscriptionForRole(prisma, lodge);
    console.log(`Lodge account seeded: ${lodgeAccountEmail}`);
  }

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
    },
  });
  await createMissingSeasonRates(winter2026.id, "winter");
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
    },
  });
  await createMissingSeasonRates(summer2026.id, "summer");
  console.log(`Season seeded: ${summer2026.name}`);

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

  // Seed generic committee placeholders only when the table is empty, so a
  // populated production committee is never touched by a re-run.
  const committeeCount = await prisma.committeeMember.count();
  if (committeeCount === 0) {
    const committeeData = buildSeedCommitteePlaceholders({
      domainEmail: clubDomainEmail,
      contactEmail: CLUB_CONTACT_EMAIL,
    });
    for (const cm of committeeData) {
      await prisma.committeeMember.create({ data: cm });
    }
    console.log(
      `Committee placeholders seeded: ${committeeData.length} entries (replace in Admin -> Committee)`,
    );
  } else {
    console.log("Committee members already present; skipping");
  }

  await seedClubTheme();

  await seedInductionChecklistTemplate();

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
