// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberBulkDialog } from "../member-bulk-dialog";

vi.mock("@/hooks/use-access-role-options", () => ({
  useAccessRoleOptions: () => [{ token: "USER", label: "Member" }],
}));
afterEach(cleanup);

const members = Array.from({ length: 12 }, (_, i) => ({
  id: String(i), name: `Selected member ${i + 1}`,
}));
function show(action: "deactivate" | "reactivate" | "set-role", count = 12) {
  render(<MemberBulkDialog open action={action}
    selectedIds={new Set(members.slice(0, count).map(m => m.id))}
    selectedMembers={members.slice(0, count)}
    onOpenChange={vi.fn()} onUpdated={vi.fn()} onError={vi.fn()} />);
}
describe("bulk member confirmation", () => {
  it("names every selected member up to ten, then counts the remainder", () => {
    show("deactivate");
    for (const member of members.slice(0, 10)) expect(screen.getByText(member.name)).toBeInTheDocument();
    expect(screen.queryByText("Selected member 11")).not.toBeInTheDocument();
    expect(screen.getByText("and 2 more")).toBeInTheDocument();
  });
  it("shows all ten names without a remainder", () => {
    show("reactivate", 10);
    expect(screen.getByText("Selected member 10")).toBeInTheDocument();
    expect(screen.queryByText(/and \d+ more/)).not.toBeInTheDocument();
  });
  it("counts a selected member the page has no name for in the remainder", () => {
    render(<MemberBulkDialog open action="deactivate"
      selectedIds={new Set(["0", "1", "off-page"])}
      selectedMembers={members.slice(0, 2)}
      onOpenChange={vi.fn()} onUpdated={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByText("Selected member 2")).toBeInTheDocument();
    expect(screen.getByText("and 1 more")).toBeInTheDocument();
  });
  it("explains the leaving date and the placements Reactivate cannot restore", () => {
    show("deactivate");
    expect(screen.getByText(/leaving date will be set to today/i)).toHaveTextContent(/future shared-room bed placements will be cleared.*not restored by Reactivate/i);
  });
  it("explains that Reactivate clears the leaving date", () => {
    show("reactivate");
    expect(screen.getByText(/leaving date will be cleared/i)).toBeInTheDocument();
  });
  it("explains that the chosen access role replaces existing roles", () => {
    show("set-role");
    expect(screen.getByText(/existing access roles will be replaced by the chosen role/i)).toBeInTheDocument();
  });
});
