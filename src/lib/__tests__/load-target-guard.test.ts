import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeDatabaseTarget,
  assertSafeTarget,
} from "../../../load/lib/target-guard.js";

/**
 * #4940: the k6 harness's target guard, and the database half the volume
 * seeder runs before its first write. Port 5432 is live production Postgres on
 * club hosts; nothing here may ever reach it.
 */
const confirmed = (DATABASE_URL: string) => ({
  DATABASE_URL,
  LOAD_TEST_CONFIRM_TARGET: "1",
});

describe("assertSafeDatabaseTarget", () => {
  it("accepts the throwaway staging database on 127.0.0.1:5433", () => {
    const url = "postgresql://tac:pw@127.0.0.1:5433/tacbookings?schema=public";
    expect(assertSafeDatabaseTarget(confirmed(url))).toBe(url);
    expect(
      assertSafeDatabaseTarget(confirmed("postgres://u:p@localhost:5544/db")),
    ).toBe("postgres://u:p@localhost:5544/db");
    expect(
      assertSafeDatabaseTarget(confirmed("postgresql://u:p@[::1]:6543/db")),
    ).toBe("postgresql://u:p@[::1]:6543/db");
  });

  it("refuses port 5432 in every spelling", () => {
    for (const url of [
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@localhost:05432/db",
      "postgresql://u:p@localhost:5433/db?options=:5432",
    ]) {
      expect(() => assertSafeDatabaseTarget(confirmed(url))).toThrow(/5432/);
    }
  });

  it("refuses an omitted port, which PostgreSQL resolves to 5432", () => {
    expect(() =>
      assertSafeDatabaseTarget(confirmed("postgresql://u:p@localhost/db")),
    ).toThrow(/no explicit port/);
    expect(() =>
      assertSafeDatabaseTarget(confirmed("postgresql://u:p@localhost:/db")),
    ).toThrow(/no explicit port/);
  });

  it("refuses non-local and production-looking hosts", () => {
    for (const url of [
      "postgresql://u:p@db.tokoroa.org.nz:5433/db",
      "postgresql://u:p@prod-db.test:5433/db",
      "postgresql://u:p@10.0.0.5:5433/db",
      "postgresql://u:p@postgres:5433/db",
    ]) {
      expect(() => assertSafeDatabaseTarget(confirmed(url))).toThrow(
        /LOAD TEST TARGET REFUSED: DATABASE_URL hostname/,
      );
    }
  });

  it("refuses parameters and multi-host forms that re-point the connection", () => {
    for (const url of [
      "postgresql://u:p@localhost:5433/db?host=db.example.com",
      "postgresql://u:p@localhost:5433/db?schema=public&hostaddr=10.0.0.5",
      "postgresql://u:p@localhost:5433/db?port=6000",
      "postgresql://u:p@localhost:5433/db?%68ost=example.com",
      "postgresql://u:p@localhost:5433/db?%70ort=5432",
      "postgresql://u:p@localhost:5433/db?%68ostaddr=10.0.0.5",
      "postgresql://u:p@localhost:5433/db?connectionString=postgresql://remote/db",
      // pg reads the whole text after the first "?" as the query.
      "postgresql://u:p@localhost:5433/db?x=1?&host=127.0.0.1&port=6000",
      "postgresql://u:p@localhost:5433,db.example.com:5433/db",
    ]) {
      expect(() => assertSafeDatabaseTarget(confirmed(url))).toThrow(
        /re-point|several hosts/,
      );
    }
  });

  it("checks the host after the last @, so a password cannot smuggle one", () => {
    expect(() =>
      assertSafeDatabaseTarget(
        confirmed("postgresql://u:p@localhost:5433@db.example.com:5433/db"),
      ),
    ).toThrow(/db\.example\.com/);
  });

  it("requires the explicit opt-in and a postgres URL", () => {
    expect(() =>
      assertSafeDatabaseTarget({ DATABASE_URL: "postgresql://u:p@localhost:5433/db" }),
    ).toThrow(/LOAD_TEST_CONFIRM_TARGET=1/);
    expect(() => assertSafeDatabaseTarget({ LOAD_TEST_CONFIRM_TARGET: "1" })).toThrow(
      /DATABASE_URL is not set/,
    );
    expect(() =>
      assertSafeDatabaseTarget(confirmed("mysql://u:p@localhost:5433/db")),
    ).toThrow(/postgres/);
  });
});

describe("assertSafeTarget", () => {
  const target = (BASE_URL: string) => ({ BASE_URL, LOAD_TEST_CONFIRM_TARGET: "1" });

  it("accepts the local staging app and strips a trailing slash", () => {
    expect(assertSafeTarget(target("http://localhost:3001/"))).toBe(
      "http://localhost:3001",
    );
  });

  it("refuses 5432, deployed hosts and an unconfirmed run", () => {
    expect(() => assertSafeTarget(target("http://localhost:5432"))).toThrow(/5432/);
    expect(() => assertSafeTarget(target("http://localhost:05432"))).toThrow(/5432/);
    expect(() => assertSafeTarget(target("https://bookings.tokoroa.org.nz"))).toThrow(
      /production domain/,
    );
    expect(() => assertSafeTarget(target("https://example.com"))).toThrow(/allowlist/);
    expect(() => assertSafeTarget({ BASE_URL: "http://localhost:3001" })).toThrow(
      /LOAD_TEST_CONFIRM_TARGET/,
    );
  });

  it("names the variable it was asked to check, not always BASE_URL", () => {
    const stub = (STRIPE_STUB_URL: string) => ({
      STRIPE_STUB_URL,
      LOAD_TEST_CONFIRM_TARGET: "1",
    });
    expect(assertSafeTarget(stub("http://127.0.0.1:12111/"), "STRIPE_STUB_URL")).toBe(
      "http://127.0.0.1:12111",
    );
    // Every refusal path reports STRIPE_STUB_URL in its reason (the first line;
    // the generic usage footer below it legitimately lists BASE_URL).
    for (const [url, pattern] of [
      ["http://stub.example.com", /STRIPE_STUB_URL hostname/],
      ["http://localhost:5432", /STRIPE_STUB_URL (contains :5432|targets port 5432)/],
      ["stub.local", /STRIPE_STUB_URL ".*" is not a plain http\(s\) URL/],
      ["https://bookings.tokoroa.org.nz", /STRIPE_STUB_URL hostname/],
    ] as const) {
      let message = "";
      try {
        assertSafeTarget(stub(url), "STRIPE_STUB_URL");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, url).toMatch(pattern);
      expect(message.split("\n")[0], url).not.toMatch(/BASE_URL/);
    }
    expect(() =>
      assertSafeTarget({ LOAD_TEST_CONFIRM_TARGET: "1" }, "STRIPE_STUB_URL"),
    ).toThrow(/STRIPE_STUB_URL is not set/);
    expect(() =>
      assertSafeTarget({ STRIPE_STUB_URL: "http://localhost:12111" }, "STRIPE_STUB_URL"),
    ).toThrow(/LOAD_TEST_CONFIRM_TARGET=1 is not set.*STRIPE_STUB_URL/);
    // A BASE_URL set alone does not satisfy a check on another variable.
    expect(() =>
      assertSafeTarget(target("http://localhost:3001"), "STRIPE_STUB_URL"),
    ).toThrow(/STRIPE_STUB_URL is not set/);
  });
});

describe("the volume seeder entry point (prisma/load-volume-seed.ts)", () => {
  // The guard above is only as good as its call site: run the real entry point
  // with an unsafe target and require the guard's refusal, not a connection
  // error from a client that already dialled out. No database is reachable at
  // these addresses, so a seeder that skipped the guard fails differently.
  const repo = path.resolve(__dirname, "..", "..", "..");
  const runSeeder = (DATABASE_URL: string) =>
    spawnSync(
      path.join(repo, "node_modules", ".bin", "tsx"),
      ["--conditions=react-server", "prisma/load-volume-seed.ts"],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL,
          LOAD_TEST_CONFIRM_TARGET: "1",
          ALLOW_DEMO_SEED: "1",
        },
        timeout: 60_000,
      },
    );

  it.each([
    ["port 5432", "postgresql://u:p@localhost:5432/db", /:5432/],
    ["a non-local host", "postgresql://u:p@db.example.com:5433/db", /not on the local allowlist/],
  ])("refuses %s before it opens a connection", (_label, url, reason) => {
    const run = runSeeder(url);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toMatch(/LOAD TEST TARGET REFUSED: DATABASE_URL/);
    expect(run.stderr).toMatch(reason);
  }, 60_000);
});
