import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructors = vi.hoisted(() => ({
  client: vi.fn(function (options: unknown) {
    return { options };
  }),
  adapter: vi.fn(function (options: unknown) {
    return { options };
  }),
}));

vi.mock("@prisma/client", () => ({ PrismaClient: constructors.client }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: constructors.adapter }));

const applicationGlobal = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};
let originalClient: PropertyDescriptor | undefined;

beforeEach(() => {
  originalClient = Object.getOwnPropertyDescriptor(globalThis, "prisma");
  delete applicationGlobal.prisma;
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://test:test@127.0.0.1:1/singleton?connection_limit=10&pool_timeout=10",
  );
});

afterEach(() => {
  // Never disconnect a foreign cached client or leave our constructor double
  // available to a later suite. Restore even an originally absent property.
  delete applicationGlobal.prisma;
  if (originalClient) {
    Object.defineProperty(globalThis, "prisma", originalClient);
  }
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadIndependentModule() {
  // Re-evaluate the actual module while retaining the same process global.
  // Constructor doubles open no connections; the real adapter helper still
  // parses DATABASE_URL and supplies the options below.
  vi.resetModules();
  return (await import("@/lib/prisma")).prisma;
}

describe.each(["production", "development"])("application Prisma in %s", (mode) => {
  it("shares one client and adapter across independent module evaluations", async () => {
    vi.stubEnv("NODE_ENV", mode);
    const first = await loadIndependentModule();
    const second = await loadIndependentModule();
    const { PRISMA_CLIENT_GLOBAL_OMIT } = await import("@/lib/prisma-global-omit");

    expect(second).toBe(first);
    expect(applicationGlobal.prisma).toBe(first);
    expect(constructors.client).toHaveBeenCalledTimes(1);
    expect(constructors.adapter).toHaveBeenCalledTimes(1);
    expect(constructors.client).toHaveBeenCalledWith({
      adapter: constructors.adapter.mock.results[0].value,
      log: mode === "development" ? ["query"] : [],
      omit: PRISMA_CLIENT_GLOBAL_OMIT,
    });
    expect(constructors.adapter).toHaveBeenCalledWith({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 300_000,
    });
  });

  it("reuses an already cached client without constructing an adapter", async () => {
    vi.stubEnv("NODE_ENV", mode);
    const cached = { cached: true } as unknown as PrismaClient;
    applicationGlobal.prisma = cached;

    expect(await loadIndependentModule()).toBe(cached);
    expect(await loadIndependentModule()).toBe(cached);
    expect(applicationGlobal.prisma).toBe(cached);
    expect(constructors.client).not.toHaveBeenCalled();
    expect(constructors.adapter).not.toHaveBeenCalled();
  });
});
