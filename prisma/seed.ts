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
  }> = [
    {
      name: "Breakfast",
      description: "Prepare, cook and serve",
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 1,
    },
    {
      name: "Fridge",
      description: "Clear out old food and clean",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Essential if closing down lodge", minAge: 18, sortOrder: 2,
    },
    {
      name: "Breakfast dishes",
      description: "Wash, dry, put away and wipe tables",
      recommendedPeopleMin: 4, recommendedPeopleMax: 4,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null, minAge: 0, sortOrder: 3,
    },
    {
      name: "Dining room and kitchen floor",
      description: "Sweep and mop",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: true, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 4,
    },
    {
      name: "Oven, microwave and hob",
      description: "Clean (may be combined with dishes)",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 5,
    },
    {
      name: "Tea towels",
      description: "Boil, wring and hang in drying room; when dry, fold and put away",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ADULTS_ONLY",
      conditionalNote: "Involves boiling water and heavy pot", minAge: 18, sortOrder: 6,
    },
    {
      name: "Firewood",
      description: "Fill wood cupboard, cut kindling, clean hearth, empty ash to galvanised bin at lodge entrance (keep lid closed)",
      recommendedPeopleMin: 1, recommendedPeopleMax: 2,
      isEssential: false, ageRestriction: "ADULT_SUPERVISED",
      conditionalNote: "Adult or responsible teenager required. Children under 7 can assist alongside 1-2 youth or 1 adult",
      minAge: 7, sortOrder: 7,
    },
    {
      name: "Rubbish",
      description: "Check kitchen, bathrooms and ski room. Take all rubbish and recycling to Iwikau Recycling Centre. Line bins and wipe spills. Check with stores person re food needs. Cold ashes can go with rubbish.",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 8,
    },
    {
      name: "Dinner",
      description: "Cook and serve",
      recommendedPeopleMin: 2, recommendedPeopleMax: 3,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 9,
    },
    {
      name: "Pre-dinner dishes",
      description: "Wash, dry and put away",
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: "Only required for full lodge", minAge: 0, sortOrder: 10,
    },
    {
      name: "Dinner dishes",
      description: "Wash, dry, put away and wipe tables. Includes pots and pans.",
      recommendedPeopleMin: 4, recommendedPeopleMax: 6,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: null, minAge: 0, sortOrder: 11,
    },
    {
      name: "Women's bathroom and toilets",
      description: "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child", minAge: 0, sortOrder: 12,
    },
    {
      name: "Men's bathroom and toilets",
      description: "Clean toilets and all surfaces including inside showers. Glass clean mirror.",
      recommendedPeopleMin: 2, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "MIXED_PREFERRED",
      conditionalNote: "Ideal pairing: adult + child", minAge: 0, sortOrder: 13,
    },
    {
      name: "Ski room, drying room and foyer",
      description: "Sweep and mop. Tip dirty water under deck outside entrance.",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 14,
    },
    {
      name: "Lounge",
      description: "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1, recommendedPeopleMax: 2,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 15,
    },
    {
      name: "Bunkrooms, corridor, stairs and dining room carpet",
      description: "Vacuum floors, wipe up dust, wipe moisture from window sills",
      recommendedPeopleMin: 1, recommendedPeopleMax: 1,
      isEssential: false, ageRestriction: "ANY",
      conditionalNote: null, minAge: 0, sortOrder: 16,
    },
    {
      name: "Stores",
      description: "Stocktake ready for supply order on Sunday and Thursday mornings. Pick up stores on Mondays and Fridays as required.",
      recommendedPeopleMin: 1, recommendedPeopleMax: 2,
      isEssential: true, ageRestriction: "ADULTS_ONLY",
      conditionalNote: null, minAge: 18, sortOrder: 17,
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
      },
    });
    console.log("Admin user seeded: support@tokoroa.org.nz / admin123");
  }

  // Seed test member
  const existingMember = await prisma.member.findUnique({
    where: { email: "member@tac.org.nz" },
  });

  if (!existingMember) {
    const memberPasswordHash = await bcrypt.hash("member123", 12);
    await prisma.member.create({
      data: {
        email: "member@tac.org.nz",
        passwordHash: memberPasswordHash,
        firstName: "Test",
        lastName: "Member",
        role: "MEMBER",
        ageTier: "ADULT",
      },
    });
    console.log("Test member seeded: member@tac.org.nz / member123");
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
