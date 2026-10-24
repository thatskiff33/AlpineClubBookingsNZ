import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #4269: Next compiles `src/lib/prisma.ts` into several server bundles, and every
 * bundle evaluates its own copy of the module. Each copy that built its own
 * `PrismaClient` opened its own `pg` pool, so one container held more than its
 * `connection_limit` (22 backends against 10, measured) and a blue/green warm-up
 * exhausted `max_connections`. The client is therefore shared through
 * `globalThis`; evaluating the module again (as a second bundle does) must adopt
 * it instead of building another.
 */
const construct = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor(options: unknown) {
      construct(options);
    }
  },
}));
vi.mock("@/lib/prisma-adapter", () => ({ createPrismaPgAdapter: () => ({}) }));

const globalForPrisma = globalThis as unknown as { prisma?: unknown };

afterEach(() => {
  delete globalForPrisma.prisma;
  construct.mockClear();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("the application Prisma client", () => {
  it.each(["production", "development"])(
    "is built once when the module is evaluated twice (NODE_ENV=%s)",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      delete globalForPrisma.prisma;

      const first = (await import("@/lib/prisma")).prisma;
      vi.resetModules(); // a second bundle gets its own copy of the module
      const second = (await import("@/lib/prisma")).prisma;

      expect(construct).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    },
  );
});
