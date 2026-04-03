import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  console.log("Seeding database...")

  // Create admin user
  const adminPasswordHash = await bcrypt.hash("admin123", 12)
  const admin = await prisma.member.upsert({
    where: { email: "admin@tac.org.nz" },
    update: {},
    create: {
      email: "admin@tac.org.nz",
      passwordHash: adminPasswordHash,
      firstName: "Admin",
      lastName: "User",
      role: "ADMIN",
      ageTier: "ADULT",
      active: true,
    },
  })
  console.log(`Admin user created: ${admin.email}`)

  // Create test member
  const memberPasswordHash = await bcrypt.hash("member123", 12)
  const member = await prisma.member.upsert({
    where: { email: "member@tac.org.nz" },
    update: {},
    create: {
      email: "member@tac.org.nz",
      passwordHash: memberPasswordHash,
      firstName: "Test",
      lastName: "Member",
      role: "MEMBER",
      ageTier: "ADULT",
      active: true,
    },
  })
  console.log(`Test member created: ${member.email}`)

  // Create Winter 2026 season (June - September)
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
  })
  console.log(`Season created: ${winter2026.name}`)

  // Create Summer 2026-27 season (November - March)
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
  })
  console.log(`Season created: ${summer2026.name}`)

  // Create default cancellation policy
  await prisma.cancellationPolicy.deleteMany()
  await prisma.cancellationPolicy.createMany({
    data: [
      { daysBeforeStay: 14, refundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50 },
      { daysBeforeStay: 0, refundPercentage: 0 },
    ],
  })
  console.log("Default cancellation policy created (14d=100%, 7d=50%, 0d=0%)")

  console.log("Seeding complete!")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
