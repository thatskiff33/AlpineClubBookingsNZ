import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create admin user
  const adminPassword = await bcrypt.hash("admin123", 10);
  const admin = await prisma.member.upsert({
    where: { email: "admin@tac.co.nz" },
    update: {},
    create: {
      email: "admin@tac.co.nz",
      passwordHash: adminPassword,
      firstName: "Admin",
      lastName: "User",
      role: "ADMIN",
      active: true,
    },
  });
  console.log(`Created admin: ${admin.email}`);

  // Create test member
  const memberPassword = await bcrypt.hash("member123", 10);
  const member = await prisma.member.upsert({
    where: { email: "member@tac.co.nz" },
    update: {},
    create: {
      email: "member@tac.co.nz",
      passwordHash: memberPassword,
      firstName: "Test",
      lastName: "Member",
      role: "MEMBER",
      active: true,
    },
  });
  console.log(`Created member: ${member.email}`);

  // Create Winter 2026 season (June-September)
  const winter2026 = await prisma.season.upsert({
    where: { id: "winter-2026" },
    update: {},
    create: {
      id: "winter-2026",
      name: "Winter 2026",
      type: "WINTER",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-09-30"),
      active: true,
      rates: {
        create: [
          { ageTier: "ADULT", isMember: true, pricePerNightCents: 4500 },
          { ageTier: "ADULT", isMember: false, pricePerNightCents: 7000 },
          { ageTier: "YOUTH", isMember: true, pricePerNightCents: 3000 },
          { ageTier: "YOUTH", isMember: false, pricePerNightCents: 5000 },
          { ageTier: "CHILD", isMember: true, pricePerNightCents: 1500 },
          { ageTier: "CHILD", isMember: false, pricePerNightCents: 3000 },
        ],
      },
    },
  });
  console.log(`Created season: ${winter2026.name}`);

  // Create Summer 2026 season (October-May)
  const summer2026 = await prisma.season.upsert({
    where: { id: "summer-2026" },
    update: {},
    create: {
      id: "summer-2026",
      name: "Summer 2025-2026",
      type: "SUMMER",
      startDate: new Date("2025-10-01"),
      endDate: new Date("2026-05-31"),
      active: true,
      rates: {
        create: [
          { ageTier: "ADULT", isMember: true, pricePerNightCents: 3500 },
          { ageTier: "ADULT", isMember: false, pricePerNightCents: 5500 },
          { ageTier: "YOUTH", isMember: true, pricePerNightCents: 2500 },
          { ageTier: "YOUTH", isMember: false, pricePerNightCents: 4000 },
          { ageTier: "CHILD", isMember: true, pricePerNightCents: 1000 },
          { ageTier: "CHILD", isMember: false, pricePerNightCents: 2000 },
        ],
      },
    },
  });
  console.log(`Created season: ${summer2026.name}`);

  // Create cancellation policy
  await prisma.cancellationPolicy.upsert({
    where: { daysBeforeStay: 14 },
    update: {},
    create: { daysBeforeStay: 14, refundPercentage: 100 },
  });
  await prisma.cancellationPolicy.upsert({
    where: { daysBeforeStay: 7 },
    update: {},
    create: { daysBeforeStay: 7, refundPercentage: 50 },
  });
  await prisma.cancellationPolicy.upsert({
    where: { daysBeforeStay: 0 },
    update: {},
    create: { daysBeforeStay: 0, refundPercentage: 0 },
  });
  console.log("Created cancellation policies");

  console.log("Seeding complete!");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
