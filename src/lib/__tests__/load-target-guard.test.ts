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
});
