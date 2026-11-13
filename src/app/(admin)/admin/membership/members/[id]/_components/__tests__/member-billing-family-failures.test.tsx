// @vitest-environment jsdom

/**
 * A refused billing-family change says why (#4976, ALP-589).
 *
 * The save used to parse every reply as JSON and toast `err.message`, so an
 * HTML 502 from the proxy read as a JSON parse error and a dropped connection
 * as "Failed to fetch". The refusal now reads through the shared reader.
 */

import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";

vi.mock("sonner", async () => (await import("@/lib/__tests__/support/toast-to-document")).sonnerToDocument);

// Radix's Select is not drivable through jsdom; a plain select drives `save`.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }) => (
    <select aria-label="Billing family" value={value ?? ""} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

import { MemberBillingFamilyCard } from "../member-billing-family-card";

const onChange = vi.fn();

async function chooseTheSecondFamily(answer: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  render(
    <MemberBillingFamilyCard
      memberId="member-1"
      billingFamilyGroupId="family-a"
      familyGroups={[
        { id: "family-a", name: "Family A" },
        { id: "family-b", name: "Family B" },
      ]}
      familyBillingMode="BILL_FAMILY_VIA_BILLING_MEMBER"
      canEdit
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Billing family" }), {
    target: { value: "family-b" },
  });
}

describe("member billing family card", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    onChange.mockReset();
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  itShowsEveryRefusal({
    fallback: "Failed to update billing family",
    submit: chooseTheSecondFamily,
  });

  it("puts the selection back after a refusal", async () => {
    await chooseTheSecondFamily(() => Response.json({ error: "No." }, { status: 409 }));

    expect(await screen.findByText("No.")).toBeInTheDocument();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Billing family" }).value).toBe("family-a");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports a saved change to the page", async () => {
    await chooseTheSecondFamily(() => Response.json({ success: true }));

    expect(await screen.findByText("Billing family updated")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith("family-b");
  });
});
