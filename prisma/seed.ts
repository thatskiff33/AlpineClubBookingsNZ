import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

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
    ageRestriction: "ANY" | "ADULTS_ONLY" | "MIXED_PREFERRED" | "ADULT_SUPERVISED";
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
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 1,
      timeOfDay: "MORNING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Fridge",
      description: "Clear out old food and clean",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Essential if closing down lodge", minAge: 18, sortOrder: 2,
      timeOfDay: "MORNING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Breakfast dishes",
      description: "Wash, dry, put away and wipe tables",
      recommendedPeopleMin: 4, recommendedPeopleMax: 4,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null, minAge: 0, sortOrder: 3,
      timeOfDay: "MORNING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Dining room and kitchen floor",
      description: "Sweep and mop",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: true, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 4,
      timeOfDay: "MORNING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Oven, microwave and hob",
      description: "Clean (may be combined with dishes)",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 5,
      timeOfDay: "MORNING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Tea towels",
      description: "Boil, wring and hang in drying room; when dry, fold and put away",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Involves boiling water and heavy pot", minAge: 18, sortOrder: 6,
      timeOfDay: "MORNING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Firewood",
      description: "Fill wood cupboard, cut kindling, clean hearth, empty ash to galvanised bin at lodge entrance (keep lid closed)",
      recommendedPeopleMin: 1, recommendedPeopleMax: 2,
      isEssential: false, ageRestriction: "ADULT_SUPERVISED",
      conditionalNote: "Adult or responsible teenager required. Children under 7 can assist alongside 1-2 youth or 1 adult",
      minAge: 7, sortOrder: 7,
      timeOfDay: "ANYTIME", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Rubbish",
      description: "Check kitchen, bathrooms and ski room. Take all rubbish and recycling to Iwikau Recycling Centre. Line bins and wipe spills. Check with stores person re food needs. Cold ashes can go with rubbish.",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 8,
      timeOfDay: "ANYTIME", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Dinner",
      description: "Cook and serve",
      recommendedPeopleMin: 2, recommendedPeopleMax: 3,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 9,
      timeOfDay: "EVENING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Pre-dinner dishes",
      description: "Wash, dry and put away",
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: "Only required for full lodge", minAge: 0, sortOrder: 10,
      timeOfDay: "EVENING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Dinner dishes",
      description: "Wash, dry, put away and wipe tables. Includes pots and pans.",
      recommendedPeopleMin: 4, recommendedPeopleMax: 6,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null, minAge: 0, sortOrder: 11,
      timeOfDay: "EVENING", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Women's bathroom and toilets",
      description: "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child", minAge: 0, sortOrder: 12,
      timeOfDay: "ANYTIME", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Men's bathroom and toilets",
      description: "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child", minAge: 0, sortOrder: 13,
      timeOfDay: "ANYTIME", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Ski room, drying room and foyer",
      description: "Sweep and mop. Tip dirty water under deck outside entrance.",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 14,
      timeOfDay: "ANYTIME", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Lounge",
      description: "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1, recommendedPeopleMax: 2,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 15,
      timeOfDay: "ANYTIME", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Bunkrooms, corridor, stairs and dining room carpet",
      description: "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 16,
      timeOfDay: "ANYTIME", frequencyMode: "DAILY", frequencyDays: null, frequencyDaysOfWeek: [],
    },
    {
      name: "Stores",
      description: "Stocktake ready for supply order on Sunday and Thursday mornings. Pick up stores on Mondays and Fridays as required.",
      recommendedPeopleMin: 1, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 17,
      timeOfDay: "ANYTIME", frequencyMode: "SPECIFIC_DAYS", frequencyDays: null, frequencyDaysOfWeek: [1, 4, 5, 7],
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
    const passwordHash = await bcrypt.hash("admin123", 12);
    await prisma.member.create({
      data: {
        email: "support@tokoroa.org.nz",
        passwordHash,
        firstName: "Admin",
        lastName: "User",
        role: "ADMIN",
        ageTier: "ADULT",
        emailVerified: true,
        forcePasswordChange: true,
      },
    });
    console.log("Admin user seeded: support@tokoroa.org.nz / admin123 (password change required on first login)");
  }

  // Seed lodge account (shared iPad in lodge)
  const existingLodge = await prisma.member.findFirst({
    where: { email: "lodge@tokoroa.org.nz" },
  });

  if (!existingLodge) {
    const lodgePasswordHash = await bcrypt.hash("lodge123", 12);
    await prisma.member.create({
      data: {
        email: "lodge@tokoroa.org.nz",
        passwordHash: lodgePasswordHash,
        firstName: "Lodge",
        lastName: "Kiosk",
        role: "LODGE",
        ageTier: "ADULT",
        emailVerified: true,
        forcePasswordChange: false,
      },
    });
    console.log("Lodge account seeded: lodge@tokoroa.org.nz / lodge123");
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
        create: [
          { ageTier: "ADULT", isMember: true, pricePerNightCents: 4500 },
          { ageTier: "ADULT", isMember: false, pricePerNightCents: 6500 },
          { ageTier: "YOUTH", isMember: true, pricePerNightCents: 3000 },
          { ageTier: "YOUTH", isMember: false, pricePerNightCents: 4500 },
          { ageTier: "CHILD", isMember: true, pricePerNightCents: 1500 },
          { ageTier: "CHILD", isMember: false, pricePerNightCents: 2500 },
        ],
      },
    },
  });
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
        create: [
          { ageTier: "ADULT", isMember: true, pricePerNightCents: 3500 },
          { ageTier: "ADULT", isMember: false, pricePerNightCents: 5000 },
          { ageTier: "YOUTH", isMember: true, pricePerNightCents: 2500 },
          { ageTier: "YOUTH", isMember: false, pricePerNightCents: 3500 },
          { ageTier: "CHILD", isMember: true, pricePerNightCents: 1000 },
          { ageTier: "CHILD", isMember: false, pricePerNightCents: 2000 },
        ],
      },
    },
  });
  console.log(`Season seeded: ${summer2026.name}`);

  // Seed Xero account mappings with current defaults (XAM-01)
  const accountMappings = [
    { key: "hutFeesIncome", code: "200" },
    { key: "hutFeeRefunds", code: "200" },
    { key: "stripeBankAccount", code: "606" },
    { key: "stripeFees", code: null },
    { key: "subscriptionIncome", code: "203" },
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
  const ageTierSettings = [
    { tier: "CHILD" as const, minAge: 0, maxAge: 9, label: "Child (under 10)", sortOrder: 1 },
    { tier: "YOUTH" as const, minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
    { tier: "ADULT" as const, minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 3 },
  ];
  for (const setting of ageTierSettings) {
    await prisma.ageTierSetting.upsert({
      where: { tier: setting.tier },
      update: {},
      create: setting,
    });
  }
  console.log("Age tier settings seeded");

  // Seed committee members (replaces hardcoded src/data/committee.ts)
  const committeeData = [
    {
      role: "President",
      name: "Michael Higgins",
      phone: "+64 20 4079 4310",
      email: "president@tokoroa.org.nz",
      contactKey: "president",
      description: "Chairs meetings and oversees club operations.",
      sortOrder: 0,
    },
    {
      role: "Secretary",
      name: "Sally Woodfield",
      phone: "+64 21 686 020",
      email: "secretary@tokoroa.org.nz",
      contactKey: "secretary",
      description: "Manages club correspondence and meeting minutes.",
      sortOrder: 1,
    },
    {
      role: "Treasurer",
      name: "Jordan Hartley-Smith",
      phone: "+64 27 422 4115",
      email: "treasurer@tokoroa.org.nz",
      contactKey: "treasurer",
      description: "Manages club finances, subscriptions, and accounts.",
      sortOrder: 2,
    },
    {
      role: "Booking Officer",
      name: "Chris Duyvestyn",
      phone: "+64 27 472 1328",
      email: "bookings@tokoroa.org.nz",
      contactKey: "bookings",
      description: "Manages lodge bookings, confirms non-member stays, and handles booking enquiries.",
      sortOrder: 3,
    },
    {
      role: "Communications Officer",
      name: "Wayne Peterson",
      phone: "+64 21 832 118",
      email: "communications@tokoroa.org.nz",
      contactKey: "communications",
      description: "Manages club communications, newsletters, and public information.",
      sortOrder: 4,
    },
    {
      role: "Lodge Maintenance Officer",
      name: "Lance Pilcher",
      phone: "+64 27 699 2688",
      email: null,
      contactKey: null,
      description: "Coordinates lodge maintenance, working bees, and improvement projects.",
      sortOrder: 5,
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
