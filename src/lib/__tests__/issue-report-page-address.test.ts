/** ALP-724: the page address an AI app reads from a problem report is its path only. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { issueReportPagePath } from "@/lib/issue-report-page-address";

describe("issueReportPagePath", () => {
  it.each([
    ["https://club.example.test/login/magic?token=abc#top", "/login/magic"],
    ["/bookings/new?member=rua@example.test", "/bookings/new"],
    ["/admin/support", "/admin/support"],
    ["bookings?x=1", "/bookings"],
  ])("%s -> %s", (pageUrl, path) => {
    expect(issueReportPagePath(pageUrl)).toBe(path);
  });
});
