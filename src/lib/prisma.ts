/**
 * `import "server-only"` makes the production build REFUSE this module in a
 * browser bundle, at any depth (`INV-OPS-013`, #2850). Operator CLIs reach it
 * under plain Node, where that marker would throw at import, so every `tsx`
 * invocation that reaches it runs with `--conditions=react-server` — which
 * resolves `server-only` to an empty module. `cli-server-only-reach-census.test.ts`
 * enforces that pairing; `docs/invariants/operations.md` carries the reasoning.
 */
import "server-only";

import { PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "@/lib/prisma-adapter";
import { PRISMA_CLIENT_GLOBAL_OMIT } from "@/lib/prisma-global-omit";

function createApplicationPrismaClient() {
  return new PrismaClient({
    adapter: createPrismaPgAdapter(),
    log: process.env.NODE_ENV === "development" ? ["query"] : [],
    // `INV-PRIV-022`: dietary/allergy data is absent from every default Member
    // projection; only src/lib/member-dietary.ts selects it.
    omit: PRISMA_CLIENT_GLOBAL_OMIT,
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * The application client, TYPED as the plain `PrismaClient` although it is
 * constructed with `omit` (#2941). This is deliberate and it is the one place
 * the runtime and the static type differ.
 *
 * Prisma types a client built with a global `omit` as a distinct generic
 * instance whose Member rows lack `dietaryRequirements`, and that instance is
 * not assignable to `Prisma.TransactionClient` or `PrismaClient`: every one of
 * the ~160 helpers that accept either would stop compiling (measured: 154
 * errors across 70 files), and re-typing them would touch almost every
 * lifecycle, money and booking module in the tree for no behavioural change.
 *
 * What protects the value is the RUNTIME omission, not the type: a Member read
 * without an explicit select really does come back without the column. The
 * static type still claims the field exists, so a caller that reads
 * `.dietaryRequirements` off an ordinary row would get `undefined`, not the
 * value. `member-dietary-access-census.test.ts` closes that gap from the other
 * side: the identifier may appear only in a closed, counted list of files, and
 * only `src/lib/member-dietary.ts` may select it.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  (createApplicationPrismaClient() as unknown as PrismaClient);

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
