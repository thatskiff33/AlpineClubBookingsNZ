import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { subjectAccessExportFilename } from "@/lib/subject-access-export-response";

/**
 * The subject access file is named from the club's own identity (#4915), as a
 * filesystem-safe slug: never one club's hard-coded short name, and never the
 * subject's name.
 */
describe("subject access export file name", () => {
  it("uses a non-default club's short name as a safe slug", () => {
    expect(
      subjectAccessExportFilename({ shortName: "Ōhau Ski Club!", name: "Ōhau Snow Sports" }, "my-data", "2026-07-01"),
    ).toBe("ohau-ski-club-my-data-2026-07-01.json");
  });

  it("falls back to the club's name, then to the kind alone", () => {
    expect(subjectAccessExportFilename({ shortName: "  ", name: "Ruapehu Lodge Trust" }, "subject-access-report", "2026-07-01"))
      .toBe("ruapehu-lodge-trust-subject-access-report-2026-07-01.json");
    expect(subjectAccessExportFilename({ shortName: "", name: "***" }, "my-data", "2026-07-01"))
      .toBe("my-data-2026-07-01.json");
  });

  it("keeps quotes and path separators out of the Content-Disposition value", () => {
    const name = subjectAccessExportFilename({ shortName: `a"b/..\\c`, name: "x" }, "my-data", "2026-07-01");
    expect(name).toBe("a-b-c-my-data-2026-07-01.json");
  });
});
