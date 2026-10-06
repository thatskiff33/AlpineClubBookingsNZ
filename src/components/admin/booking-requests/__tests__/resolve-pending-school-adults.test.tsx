// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResolvePendingSchoolAdults } from "../resolve-pending-school-adults";

afterEach(() => vi.unstubAllGlobals());

describe("accepted school adult naming", () => {
  it("discards an unsaved name on Cancel", () => {
    render(<ResolvePendingSchoolAdults requestId="request-1" expectedVersion={4} pendingAdultCount={1} canEdit onResolved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Name one pending adult" }));
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Name one pending adult" }));
    expect(screen.getByLabelText("First name")).toHaveValue("");
  });

  it("does not offer a second naming write when save committed but refresh failed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResolvePendingSchoolAdults requestId="request-1" expectedVersion={4} pendingAdultCount={2} canEdit onResolved={vi.fn().mockRejectedValue(new Error("refresh unavailable"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Name one pending adult" }));
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Beth" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Teacher" } });
    fireEvent.click(screen.getByRole("button", { name: "Save real name" }));

    await waitFor(() => expect(screen.getByText(/name was saved, but this page could not refresh/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Name one pending adult" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
