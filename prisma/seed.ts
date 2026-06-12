import { type AgeTier, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { clubConfig } from "../src/config/club";
import {
  CLUB_CONTACT_EMAIL,
  clubDomainEmail,
} from "../src/config/club-identity";
import { createPrismaPgAdapter } from "../src/lib/prisma-adapter";

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(),
});

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

const starterPageContent: Array<{
  slug: string;
  path: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  sortOrder: number;
  contentHtml: string;
}> = [
  {
    slug: "home",
    path: "/home",
    caption: "",
    menuTitle: "",
    title: "Home",
    headerText: "",
    sortOrder: 0,
    contentHtml: "",
  },
  {
    slug: "about",
    path: "/about",
    caption: "About the Club",
    menuTitle: "About",
    title: "About",
    headerText: "Learn about our club history, values, and alpine community.",
    sortOrder: 10,
    contentHtml: `<h2>About the Club</h2>`.trim(),
  },
  {
    slug: "join",
    path: "/join",
    caption: "Join the Club",
    menuTitle: "Join",
    title: "Join",
    headerText:
      "Nomination by two current members, induction process, and membership details.",
    sortOrder: 20,
    contentHtml: `<h2>Becoming a Member</h2>`.trim(),
  },
  {
    slug: "join/apply",
    path: "/join/apply",
    caption: "Membership Application",
    menuTitle: "",
    title: "Apply for Membership",
    headerText:
      "Enter your details, nominate two current club members, and we will move your application through nomination confirmation and committee approval.",
    sortOrder: 25,
    contentHtml: "{{member-application-form}}",
  },
  {
    slug: "contact",
    path: "/contact",
    caption: "Get in touch",
    menuTitle: "",
    title: "Contact Us",
    headerText:
      "Have a question about the club, the lodge, or booking a stay? Get in touch and we'll get back to you.",
    sortOrder: 27,
    contentHtml: "{{contact-form}}",
  },
  {
    slug: "committee",
    path: "/committee",
    caption: "Volunteer leadership",
    menuTitle: "Committee",
    title: "Committee",
    headerText:
      "The club is run entirely by volunteers. Meet the committee members who keep things going.",
    sortOrder: 30,
    contentHtml: "{{committee-members-cards}}",
  },
  {
    slug: "404",
    path: "/404",
    caption: "404",
    menuTitle: "",
    title: "Page Not Found",
    headerText: "The page you're looking for doesn't exist or has been moved.",
    sortOrder: 999,
    contentHtml:
      "<p>You can return home or continue to booking from the links below.</p>",
  },
];

async function upsertSeasonRates(
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
      update: {
        pricePerNightCents: rate.pricePerNightCents,
      },
      create: {
        seasonId,
        ...rate,
      },
    });
  }
}

async function main() {
  console.log("Seeding database...");

  const seedAdminEmail = requireSeedEnv("SEED_ADMIN_EMAIL").toLowerCase();
  const seedAdminPassword = requireSeedEnv("SEED_ADMIN_PASSWORD");

  // Seed default cancellation policy
  const policies = [
    { daysBeforeStay: 14, refundPercentage: 100 },
    { daysBeforeStay: 7, refundPercentage: 50 },
    { daysBeforeStay: 0, refundPercentage: 0 },
  ];

  for (const policy of policies) {
    await prisma.cancellationPolicy.upsert({
      where: { daysBeforeStay: policy.daysBeforeStay },
      update: { refundPercentage: policy.refundPercentage },
      create: policy,
    });
  }

  console.log("Cancellation policies seeded");

  // Seed chore templates (17 chores with full lodge allocation rules)
  // Clear old chore templates first (safe - no assignments in seed)
  await prisma.choreTemplate.deleteMany({});

  const choreTemplates: Array<{
    name: string;
    description: string;
    recommendedPeopleMin: number;
    recommendedPeopleMax: number;
    isEssential: boolean;
    ageRestriction:
      | "ANY"
      | "ADULTS_ONLY"
      | "MIXED_PREFERRED"
      | "ADULT_SUPERVISED";
    conditionalNote: string | null;
    minAge: number;
    sortOrder: number;
    timeOfDay: "MORNING" | "EVENING" | "ANYTIME";
    frequencyMode: "DAILY" | "EVERY_X_DAYS" | "SPECIFIC_DAYS";
    frequencyDays: number | null;
    frequencyDaysOfWeek: number[];
  }> = [
    {
      name: "Breakfast",
      description: "Prepare, cook and serve",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 1,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Fridge",
      description: "Clear out old food and clean",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Essential if closing down lodge",
      minAge: 18,
      sortOrder: 2,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Breakfast dishes",
      description: "Wash, dry, put away and wipe tables",
      recommendedPeopleMin: 4,
      recommendedPeopleMax: 4,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 3,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Dining room and kitchen floor",
      description: "Sweep and mop",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: true,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 4,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Oven, microwave and hob",
      description: "Clean (may be combined with dishes)",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 5,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Tea towels",
      description:
        "Boil, wring and hang in drying room; when dry, fold and put away",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Involves boiling water and heavy pot",
      minAge: 18,
      sortOrder: 6,
      timeOfDay: "MORNING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Firewood",
      description:
        "Fill wood cupboard, cut kindling, clean hearth, empty ash to galvanised bin at lodge entrance (keep lid closed)",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 2,
      isEssential: false,
      ageRestriction: "ADULT_SUPERVISED",
      conditionalNote:
        "Adult or responsible teenager required. Children under 7 can assist alongside 1-2 youth or 1 adult",
      minAge: 7,
      sortOrder: 7,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Rubbish",
      description:
        "Check kitchen, bathrooms and ski room. Take all rubbish and recycling to Iwikau Recycling Centre. Line bins and wipe spills. Check with stores person re food needs. Cold ashes can go with rubbish.",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 8,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Dinner",
      description: "Cook and serve",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 3,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 9,
      timeOfDay: "EVENING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Pre-dinner dishes",
      description: "Wash, dry and put away",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: "Only required for full lodge",
      minAge: 0,
      sortOrder: 10,
      timeOfDay: "EVENING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Dinner dishes",
      description:
        "Wash, dry, put away and wipe tables. Includes pots and pans.",
      recommendedPeopleMin: 4,
      recommendedPeopleMax: 6,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 11,
      timeOfDay: "EVENING",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Women's bathroom and toilets",
      description:
        "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child",
      minAge: 0,
      sortOrder: 12,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Men's bathroom and toilets",
      description:
        "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child",
      minAge: 0,
      sortOrder: 13,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Ski room, drying room and foyer",
      description:
        "Sweep and mop. Tip dirty water under deck outside entrance.",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 14,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Lounge",
      description:
        "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 2,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 15,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Bunkrooms, corridor, stairs and dining room carpet",
      description:
        "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 1,
      isEssential: false,
      ageRestriction: "ANY",
      conditionalNote: null,
      minAge: 0,
      sortOrder: 16,
      timeOfDay: "ANYTIME",
      frequencyMode: "DAILY",
      frequencyDays: null,
      frequencyDaysOfWeek: [],
    },
    {
      name: "Stores",
      description:
        "Stocktake ready for supply order on Sunday and Thursday mornings. Pick up stores on Mondays and Fridays as required.",
      recommendedPeopleMin: 1,
      recommendedPeopleMax: 2,
      isEssential: true,
      ageRestriction: "ADULTS_ONLY",
      conditionalNote: null,
      minAge: 18,
      sortOrder: 17,
      timeOfDay: "ANYTIME",
      frequencyMode: "SPECIFIC_DAYS",
      frequencyDays: null,
      frequencyDaysOfWeek: [1, 4, 5, 7],
    },
  ];

  for (const chore of choreTemplates) {
    await prisma.choreTemplate.create({ data: chore });
  }

  console.log("Chore templates seeded: 17 templates");

  // Seed admin user (only if no admin exists)
  const existingAdmin = await prisma.member.findFirst({
    where: { role: "ADMIN" },
  });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(seedAdminPassword, 12);
    await prisma.member.create({
      data: {
        email: seedAdminEmail,
        passwordHash,
        firstName: "Admin",
        lastName: "User",
        role: "ADMIN",
        ageTier: "ADULT",
        emailVerified: true,
        forcePasswordChange: true,
      },
    });
    console.log(
      `Admin user seeded: ${seedAdminEmail} (password change required on first login)`,
    );
  }

  // Seed lodge account (shared iPad in lodge)
  const lodgeAccountEmail = clubDomainEmail("lodge");
  const existingLodge = await prisma.member.findFirst({
    where: { email: lodgeAccountEmail },
  });

  if (!existingLodge) {
    const lodgePasswordHash = await bcrypt.hash(
      requireSeedEnv("SEED_LODGE_PASSWORD"),
      12,
    );
    await prisma.member.create({
      data: {
        email: lodgeAccountEmail,
        passwordHash: lodgePasswordHash,
        firstName: "Lodge",
        lastName: "Kiosk",
        role: "LODGE",
        ageTier: "ADULT",
        emailVerified: true,
        forcePasswordChange: false,
      },
    });
    console.log(`Lodge account seeded: ${lodgeAccountEmail}`);
  }

  // Seed Winter 2026 season (June - September) with rates
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
      rates: {
        create: seedRatesForSeason("winter"),
      },
    },
  });
  await upsertSeasonRates(winter2026.id, "winter");
  console.log(`Season seeded: ${winter2026.name}`);

  // Seed Summer 2026-27 season (November - March) with rates
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
      rates: {
        create: seedRatesForSeason("summer"),
      },
    },
  });
  await upsertSeasonRates(summer2026.id, "summer");
  console.log(`Season seeded: ${summer2026.name}`);

  // Seed Xero account mappings with current defaults (XAM-01)
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

  // Seed age tier settings with correct TAC boundaries (Issue 14)
  const ageTierSettings = seedAgeTierSettings();
  for (const setting of ageTierSettings) {
    await prisma.ageTierSetting.upsert({
      where: { tier: setting.tier },
      update: {
        minAge: setting.minAge,
        maxAge: setting.maxAge,
        label: setting.label,
        subscriptionRequiredForBooking: setting.subscriptionRequiredForBooking,
        familyGroupRequestCreateMemberAllowed:
          setting.familyGroupRequestCreateMemberAllowed,
        sortOrder: setting.sortOrder,
      },
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

  // Seed committee members (replaces hardcoded src/data/committee.ts)
  const committeeData = [
    {
      role: "President",
      name: "Judy Clark",
      phone: "+64 27 484 3060",
      email: clubDomainEmail("president"),
      contactKey: "president",
      description: "Chairs meetings and oversees club operations.",
      sortOrder: 0,
    },
    {
      role: "Vice President",
      name: "Andy Thomson",
      phone: "+64 21 049 8886",
      email: clubDomainEmail("vicePresident"),
      contactKey: "vicePresident",
      description: "Backup to the President and assists with club operations.",
      sortOrder: 1,
    },
    {
      role: "Secretary",
      name: "Dale Thompson",
      phone: "+64 21 212 9488",
      email: clubDomainEmail("secretary"),
      contactKey: "secretary",
      description: "Manages club correspondence and meeting minutes.",
      sortOrder: 2,
    },
    {
      role: "Treasurer",
      name: "Katie Bridge",
      phone: "+64 27 634 8525",
      email: clubDomainEmail("treasurer"),
      contactKey: "treasurer",
      description: "Manages club finances, subscriptions, and accounts.",
      sortOrder: 2,
    },
    {
      role: "Membership Officer",
      name: "Kath Eastham",
      phone: "+64 021 452 842",
      email: clubDomainEmail("membership"),
      contactKey: "membership",
      description: "Manages club membership, renewals, and member records.",
      sortOrder: 3,
    },
    {
      role: "Booking Officer",
      name: "Andy Schulz",
      phone: "+64 21 031 1144",
      email: CLUB_CONTACT_EMAIL,
      contactKey: "bookings",
      description:
        "Manages lodge bookings, confirms non-member stays, and handles booking enquiries.",
      sortOrder: 4,
    },
    {
      role: "Media/Communications Officer",
      name: "Kent Le Quesne",
      phone: "+64 22 428 9146",
      email: clubDomainEmail("media"),
      contactKey: "media",
      description:
        "Manages club communications, media, newsletters, and public information.",
      sortOrder: 5,
    },
    {
      role: "Lodge Maintenance Officer",
      name: "Joe Clark",
      phone: "+64 21 708 648",
      email: clubDomainEmail("works"),
      contactKey: "works",
      description:
        "Coordinates lodge maintenance, working bees, and improvement projects.",
      sortOrder: 6,
    },
    {
      role: "Tramping Representative",
      name: "Noel Bigwood",
      phone: "+64 27 645 3474",
      email: clubDomainEmail("tramping"),
      contactKey: "tramping",
      description:
        "Coordinates tramping activities and represents the club in tramping matters.",
      sortOrder: 7,
    },
    {
      role: "Food Officer",
      name: "Rebekah Thompson",
      phone: "+64 21 252 0714",
      email: clubDomainEmail("food"),
      contactKey: "food",
      description:
        "Coordinates food-related activities and manages club catering.",
      sortOrder: 8,
    },
    {
      role: "Patron",
      name: "Noel Bigwood",
      phone: "+64 27 645 3474",
      email: clubDomainEmail("patron"),
      contactKey: "patron",
      description:
        "The Patron is an honorary position, recognizing significant contributions to the club.",
      sortOrder: 9,
    },
    {
      role: "Committee Member 1",
      name: "Liza-Tanya Buckley",
      phone: "+64 21 166 4912",
      email: null,
      contactKey: "committeeMember1",
      description: "Committee member responsible for various club activities.",
      sortOrder: 10,
    },
    {
      role: "Committee Member 2",
      name: "Natasha Thomason",
      phone: "+64 21 240 8221",
      email: null,
      contactKey: "committeeMember2",
      description: "Committee member responsible for various club activities.",
      sortOrder: 11,
    },
    {
      role: "Committee Member 3",
      name: "Steven Thomason",
      phone: "+64 27 393 3648",
      email: null,
      contactKey: "committeeMember3",
      description: "Committee member responsible for various club activities.",
      sortOrder: 12,
    },
    {
      role: "Committee Member 4",
      name: "Jason Donovan",
      phone: "+64 27 323 9671",
      email: null,
      contactKey: "committeeMember4",
      description: "Committee member responsible for various club activities.",
      sortOrder: 13,
    },
    {
      role: "Custodian",
      name: "Custodian LWTC",
      phone: "+64 21 000 0000",
      email: clubDomainEmail("custodian"),
      contactKey: "custodian",
      description: "Responsible for the care and maintenance of club property.",
      sortOrder: 14,
    },
  ];

  for (const cm of committeeData) {
    await prisma.committeeMember.upsert({
      where: { id: `seed-committee-${cm.sortOrder}` },
      update: {
        role: cm.role,
        name: cm.name,
        phone: cm.phone,
        email: cm.email,
        contactKey: cm.contactKey,
        description: cm.description,
        sortOrder: cm.sortOrder,
      },
      create: {
        id: `seed-committee-${cm.sortOrder}`,
        ...cm,
      },
    });
  }
  console.log(`Committee members seeded: ${committeeData.length} members`);

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
