// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/lib/__tests__/support/club-time-render";
import type { ClubIdentity } from "@/config/club-identity-types";
import { SchoolBookingForm } from "@/app/(website-dynamic)/school-bookings/school-booking-form";

/**
 * THE SCHOOL FORM'S ADULT ROWS ARE NAMED FOR ASSISTIVE TECHNOLOGY (#4957).
 *
 * Each teacher or parent-helper row repeats First name / Last name / Email. The
 * visible labels used to carry no `htmlFor` and the inputs no `id`, so a screen
 * reader announced "edit text" three times per row, clicking a label did
 * nothing, and every Remove button was just "Remove". These cases find the
 * fields the way a screen reader user does — by label, row by row — so deleting
 * any one `htmlFor`/`id` pair, the row group, or the Remove name fails here.
 */

function club(): ClubIdentity {
  return {
    lodgeName: "Test Alpine Lodge",
    hutLeaderLabel: "Hut Leader",
    lodgeCapacity: 40,
  } as unknown as ClubIdentity;
}

const fetchMock = vi.fn<typeof fetch>(async (input) => {
  const url = String(input);
  if (url.includes("/api/booking-requests/settings")) {
    return {
      ok: true,
      json: async () => ({ lodges: [], defaultLodgeCapacity: 40 }),
    } as Response;
  }
  if (url.includes("/api/booking-requests/school")) {
    return { ok: true, json: async () => ({}) } as Response;
  }
  return { ok: true, json: async () => ({ settings: [] }) } as Response;
});

beforeEach(() => {
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
});

function renderWithTwoAdults() {
  const view = render(<SchoolBookingForm club={club()} />);
  fireEvent.click(screen.getByRole("button", { name: "+ Add adult" }));
  return view;
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("school booking form adult rows (#4957)", () => {
  it("links every visible label to its own row's input, in row order", () => {
    renderWithTwoAdults();

    for (const label of ["First name", "Last name", "Email (optional)"]) {
      const inputs = screen.getAllByLabelText(label);
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toBe(
        within(screen.getByRole("group", { name: "Adult 1" })).getByLabelText(label),
      );
      expect(inputs[1]).toBe(
        within(screen.getByRole("group", { name: "Adult 2" })).getByLabelText(label),
      );
    }
  });

  it("gives every input a unique id that no other element on the form uses", () => {
    const { container } = renderWithTwoAdults();

    const ids = Array.from(container.querySelectorAll("[id]"), (el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps ids unique when the form is rendered twice on one page", () => {
    render(
      <>
        <SchoolBookingForm club={club()} />
        <SchoolBookingForm club={club()} />
      </>,
    );

    const rows = screen.getAllByRole("group", { name: "Adult 1" });
    expect(rows).toHaveLength(2);
    const ids = rows.flatMap((row) =>
      Array.from(row.querySelectorAll("input"), (input) => input.id),
    );
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("associates row 2's first-name label with its input", () => {
    renderWithTwoAdults();
    const secondRow = screen.getByRole("group", { name: "Adult 2" });

    const label = within(secondRow).getByText("First name") as HTMLLabelElement;
    expect(label.control).toBe(within(secondRow).getByLabelText("First name"));
  });

  it("keeps surviving fields labelled after removing a middle row and adding another", () => {
    const { container } = renderWithTwoAdults();
    fireEvent.click(screen.getByRole("button", { name: "+ Add adult" }));

    for (const [index, name] of ["Aroha", "Ben", "Mere"].entries()) {
      const row = screen.getByRole("group", { name: `Adult ${index + 1}` });
      type(within(row).getByLabelText("First name"), name);
    }

    fireEvent.click(screen.getByRole("button", { name: "Remove adult 2" }));
    expect(screen.getAllByLabelText("First name").map((input) =>
      (input as HTMLInputElement).value,
    )).toEqual(["Aroha", "Mere"]);
    expect(screen.queryByRole("group", { name: "Adult 3" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "+ Add adult" }));
    for (const [index, name] of ["Aroha", "Mere", ""].entries()) {
      const row = screen.getByRole("group", { name: `Adult ${index + 1}` });
      expect(within(row).getByLabelText("First name")).toHaveValue(name);
      for (const label of ["First name", "Last name", "Email (optional)"]) {
        const element = within(row).getByText(label) as HTMLLabelElement;
        expect(element.control).toBe(within(row).getByLabelText(label));
      }
    }
    const ids = Array.from(container.querySelectorAll("[id]"), (el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);

    fireEvent.click(screen.getByRole("button", { name: "Remove adult 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove adult 2" }));
    const remove = screen.getByRole("button", { name: "Remove adult 1" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(screen.getAllByRole("group", { name: /^Adult / })).toHaveLength(1);
    expect(screen.getByLabelText("First name")).toHaveValue("Aroha");
  });

  it("names each Remove button after its row", () => {
    renderWithTwoAdults();

    expect(screen.getByRole("button", { name: "Remove adult 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove adult 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("submits the same teachers payload, filled through the labelled fields", async () => {
    const { container } = renderWithTwoAdults();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/booking-requests/settings"),
    );

    type(screen.getByLabelText("School name"), "Tokoroa Primary");
    type(screen.getByLabelText("Contact first name"), "Mere");
    type(screen.getByLabelText("Contact last name"), "Tane");
    type(screen.getByLabelText("Contact email (school invoice)"), "office@school.example");
    type(container.querySelector("#checkIn") as HTMLElement, "2026-08-10");
    type(container.querySelector("#checkOut") as HTMLElement, "2026-08-12");
    type(container.querySelector("#count-CHILD") as HTMLElement, "5");

    const first = screen.getByRole("group", { name: "Adult 1" });
    type(within(first).getByLabelText("First name"), "Aroha");
    type(within(first).getByLabelText("Last name"), "Ngata");
    const second = screen.getByRole("group", { name: "Adult 2" });
    type(within(second).getByLabelText("First name"), "Ben");
    type(within(second).getByLabelText("Last name"), "Smith");
    type(within(second).getByLabelText("Email (optional)"), "ben@school.example");

    fireEvent.click(screen.getByRole("button", { name: "Submit school request" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/booking-requests/school", expect.anything()),
    );
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/booking-requests/school");
    const body = JSON.parse(call?.[1]?.body as string);
    expect(body.teachers).toEqual([
      { firstName: "Aroha", lastName: "Ngata" },
      { firstName: "Ben", lastName: "Smith", email: "ben@school.example" },
    ]);
  });
});
