import { describe, expect, it } from "vitest";
import { clubDownloadFilename } from "@/lib/club-download-filename";

// #4986 (INV-CONFIG-001): downloads carry the club's own short name.
describe("clubDownloadFilename", () => {
  it("names the file from the club's short name, lower-cased and hyphenated", () => {
    expect(clubDownloadFilename("Ruapehu AC", "report", "2026-07-01", "csv")).toBe("ruapehu-ac-report-2026-07-01.csv");
    expect(clubDownloadFilename("Ruapehu AC", "report", "2026-07-01", "pdf")).toBe("ruapehu-ac-report-2026-07-01.pdf");
    expect(clubDownloadFilename("Ruapehu AC", "members", "2026-07-01", "csv")).toBe("ruapehu-ac-members-2026-07-01.csv");
    expect(clubDownloadFilename("Ruapehu AC", "my-data", "2026-07-01", "json")).toBe("ruapehu-ac-my-data-2026-07-01.json");
  });

  it("keeps macronned letters and drops characters a filename cannot carry", () => {
    expect(clubDownloadFilename("Ōhakune / Tūroa Club", "report", "2026-07-01", "pdf")).toBe("ohakune-turoa-club-report-2026-07-01.pdf");
  });

  it("falls back to a neutral prefix when nothing filename-safe survives", () => {
    expect(clubDownloadFilename("★ ★", "report", "2026-07-01", "csv")).toBe("club-report-2026-07-01.csv");
    expect(clubDownloadFilename("", "members", "2026-07-01", "csv")).toBe("club-members-2026-07-01.csv");
  });

  it("omits the day, not just its value, when no club day is known", () => {
    expect(clubDownloadFilename("Ruapehu AC", "my-data", null, "json")).toBe("ruapehu-ac-my-data.json");
  });
});
