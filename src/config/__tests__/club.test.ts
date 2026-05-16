import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadClubConfig } from "@/config/club";

const validConfig = {
  name: "Example Mountain Club",
  shortName: "EMC",
  supportEmail: "support@example.org",
  contactEmail: "bookings@example.org",
  publicUrl: "https://example.org",
  emailFromName: "Example Mountain Club - Online Booking System",
  beds: [
    { id: "lodge", name: "Main Lodge", capacity: 20, type: "dormitory" },
  ],
  ageTiers: [
    { id: "INFANT", label: "Infant", minAge: 0, maxAge: 4, subscriptionRequiredForBooking: false },
    { id: "ADULT", label: "Adult", minAge: 18, maxAge: null, subscriptionRequiredForBooking: true },
  ],
};

describe("loadClubConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "club-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(name: string, data: unknown) {
    fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(data, null, 2));
  }

  it("loads and validates club.json when present", () => {
    writeJson("club.json", validConfig);
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg.name).toBe("Example Mountain Club");
    expect(cfg.beds[0].capacity).toBe(20);
  });

  it("falls back to club.example.json when club.json is absent", () => {
    writeJson("club.example.json", {
      ...validConfig,
      name: "Fallback Club",
    });
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg.name).toBe("Fallback Club");
  });

  it("prefers club.json over club.example.json when both exist", () => {
    writeJson("club.json", { ...validConfig, name: "Primary" });
    writeJson("club.example.json", { ...validConfig, name: "Example" });
    const cfg = loadClubConfig({ configDir: tmpDir });
    expect(cfg.name).toBe("Primary");
  });

  it("throws a useful error when neither file exists", () => {
    expect(() => loadClubConfig({ configDir: tmpDir })).toThrow(/No club config found/);
  });

  it("rejects malformed JSON with a useful error", () => {
    fs.writeFileSync(path.join(tmpDir, "club.json"), "{ not json");
    expect(() => loadClubConfig({ configDir: tmpDir })).toThrow(/Invalid JSON/);
  });

  it("rejects a config that fails schema validation with the source path in the message", () => {
    writeJson("club.json", { ...validConfig, supportEmail: "garbage" });
    expect(() => loadClubConfig({ configDir: tmpDir })).toThrow(/Invalid club config/);
    expect(() => loadClubConfig({ configDir: tmpDir })).toThrow(/supportEmail/);
  });

  it("rejects a config with unknown top-level keys", () => {
    writeJson("club.json", { ...validConfig, mystery: 1 });
    expect(() => loadClubConfig({ configDir: tmpDir })).toThrow(/Invalid club config/);
  });

  it("returns the example config so an outside adopter can boot with only the example", () => {
    writeJson("club.example.json", validConfig);
    expect(() => loadClubConfig({ configDir: tmpDir })).not.toThrow();
  });
});
