import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Seed rooms: 6 rooms x 4 beds + 1 room x 5 beds = 29 beds
  const rooms = [
    { name: "Room 1", capacity: 4, sortOrder: 1, description: "4-bed bunk room" },
    { name: "Room 2", capacity: 4, sortOrder: 2, description: "4-bed bunk room" },
    { name: "Room 3", capacity: 4, sortOrder: 3, description: "4-bed bunk room" },
    { name: "Room 4", capacity: 4, sortOrder: 4, description: "4-bed bunk room" },
    { name: "Room 5", capacity: 4, sortOrder: 5, description: "4-bed bunk room" },
    { name: "Room 6", capacity: 4, sortOrder: 6, description: "4-bed bunk room" },
    { name: "Room 7", capacity: 5, sortOrder: 7, description: "5-bed bunk room" },
  ];

  for (const room of rooms) {
    await prisma.room.upsert({
      where: { id: room.name },
      update: room,
      create: room,
    });
  }

  console.log("Rooms seeded: 7 rooms, 29 beds total");

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

  // Seed default chore templates
  const chores = [
    { name: "Dishes", description: "Wash and dry all dishes", recommendedPeople: 2, minAge: 10, sortOrder: 1 },
    { name: "Sweep common area", description: "Sweep floors in the common room and kitchen", recommendedPeople: 1, minAge: 10, sortOrder: 2 },
    { name: "Clean bathrooms", description: "Clean all bathroom facilities", recommendedPeople: 2, minAge: 12, sortOrder: 3 },
    { name: "Take out rubbish", description: "Empty all bins and take rubbish to collection point", recommendedPeople: 1, minAge: 10, sortOrder: 4 },
    { name: "Wipe tables and benches", description: "Clean all surfaces in dining and kitchen areas", recommendedPeople: 1, minAge: 10, sortOrder: 5 },
  ];

  for (const chore of chores) {
    const existing = await prisma.choreTemplate.findFirst({
      where: { name: chore.name },
    });
    if (!existing) {
      await prisma.choreTemplate.create({ data: chore });
    }
  }

  console.log("Chore templates seeded");

  // Seed admin user (only if no admin exists)
  const existingAdmin = await prisma.member.findFirst({
    where: { role: "ADMIN" },
  });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash("admin123", 12);
    await prisma.member.create({
      data: {
        email: "admin@tac.org.nz",
        passwordHash,
        firstName: "Admin",
        lastName: "User",
        role: "ADMIN",
        ageTier: "ADULT",
      },
    });
    console.log("Admin user seeded: admin@tac.org.nz / admin123");
  }

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
