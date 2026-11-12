import { describe, expect, it } from "vitest";
import { clubReportFilename } from "@/lib/club-report-filename";

// #4986 (INV-CONFIG-001): report downloads carry the club's own short name.
describe("clubReportFilename", () => {
  it("names the file from the club's short name, lower-cased and hyphenated", () => {
    expect(clubReportFilename("Ruapehu AC", "2026-07-01", "csv")).toBe("ruapehu-ac-report-2026-07-01.csv");
    expect(clubReportFilename("Ruapehu AC", "2026-07-01", "pdf")).toBe("ruapehu-ac-report-2026-07-01.pdf");
  });

  it("keeps macronned letters and drops characters a filename cannot carry", () => {
    expect(clubReportFilename("Ōhakune / Tūroa Club", "2026-07-01", "pdf")).toBe("ohakune-turoa-club-report-2026-07-01.pdf");
  });

  it("falls back to a neutral prefix when nothing filename-safe survives", () => {
    expect(clubReportFilename("★ ★", "2026-07-01", "csv")).toBe("club-report-2026-07-01.csv");
  });
});
