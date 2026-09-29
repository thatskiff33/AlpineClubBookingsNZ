// Capture the E2E date authority once before seeding. The stack script stores
// this output for its separate Playwright process (#3702).
import { E2E_TODAY_NZ } from "../prisma/e2e-fixtures";

process.stdout.write(E2E_TODAY_NZ);
