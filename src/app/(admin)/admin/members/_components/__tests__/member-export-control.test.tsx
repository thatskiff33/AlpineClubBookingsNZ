// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MemberExportControl } from "@/app/(admin)/admin/members/_components/member-export-control";

describe("member export while officer sign-in is off (#4619)", () => {
  it("stays a link", () => {
    render(<MemberExportControl href="/api/admin/members/export?q=ada" />);
    const link = screen.getByRole("link", { name: "Export CSV" });
    expect(link).toHaveAttribute("href", "/api/admin/members/export?q=ada");
  });
});
