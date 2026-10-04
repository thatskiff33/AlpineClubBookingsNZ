// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchoolHutLeaderKindsCard } from "@/components/admin/school-hut-leader-kinds-card";

/**
 * "Who can be hut leader for school bookings" on the lodge hub (#3819): the
 * canonical staged-edit pattern and its view-only gating.
 */

const STORED = {
  teacherOnBooking: false,
  custodian: true,
  memberOnBooking: true,
  memberStayingSeparately: true,
};

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { kinds: typeof STORED };
      return new Response(JSON.stringify({ kinds: body.kinds }), { status: 200 });
    }
    return new Response(JSON.stringify({ kinds: STORED }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const writes = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");

function editButton() {
  return screen.getByRole("button", {
    name: "Edit who can be hut leader for school bookings",
  }) as HTMLButtonElement;
}

function teacherBox() {
  return screen.getByLabelText("A teacher on the booking") as HTMLInputElement;
}

async function renderCard(canEdit: boolean | undefined) {
  const view = render(<SchoolHutLeaderKindsCard lodgeId="lodge-2" canEdit={canEdit} />);
  await waitFor(() => expect(editButton().textContent).toBe("Edit"));
  await waitFor(() => expect(screen.getByLabelText("The lodge custodian")).toBeTruthy());
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SchoolHutLeaderKindsCard (#3819)", () => {
  it("reads the lodge's kinds, stages a change behind Edit and saves only on Save", async () => {
    const fetchMock = stubFetch();
    await renderCard(true);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/admin/lodge-settings/school-hut-leaders?lodgeId=lodge-2",
    );
    expect(teacherBox().checked).toBe(false);
    expect(teacherBox().disabled).toBe(true);

    fireEvent.click(editButton());
    fireEvent.click(teacherBox());
    expect(writes(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    expect(JSON.parse(String(writes(fetchMock)[0]![1]?.body))).toEqual({
      lodgeId: "lodge-2",
      kinds: { ...STORED, teacherOnBooking: true },
    });
    await waitFor(() =>
      expect(screen.getByText("Saved who can be hut leader for school bookings")).toBeTruthy(),
    );
  });

  it("keeps Save disabled while pristine and cancels without a write", async () => {
    const fetchMock = stubFetch();
    await renderCard(true);

    fireEvent.click(editButton());
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(teacherBox());
    expect(save.disabled).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel editing who can be hut leader for school bookings" }),
    );
    expect(teacherBox().checked).toBe(false);
    expect(writes(fetchMock)).toHaveLength(0);
  });

  it("offers a view-only admin no way in: under the lodge hub's banner the button carries no reason of its own", async () => {
    stubFetch();
    render(
      <SchoolHutLeaderKindsCard lodgeId="lodge-2" canEdit={false} ancestorRendersViewOnlyBanner />,
    );
    await waitFor(() => expect(screen.getByLabelText("The lodge custodian")).toBeTruthy());

    const edit = editButton();
    expect(edit.disabled).toBe(true);
    expect(edit.getAttribute("title")).toBeNull();
    expect(edit.getAttribute("aria-describedby")).toBeNull();
    // The card renders no banner: the page that vouches for it does.
    expect(screen.queryAllByTestId("admin-view-only-banner")).toHaveLength(0);
    expect(teacherBox().disabled).toBe(true);
  });

  it("explains itself on each disabled button when nothing vouches for a banner", async () => {
    stubFetch();
    await renderCard(false);
    const edit = editButton();
    expect(edit.disabled).toBe(true);
    expect(edit.getAttribute("aria-describedby")).not.toBeNull();
  });

  it("disables Save when access narrows mid-edit", async () => {
    stubFetch();
    const view = await renderCard(true);
    fireEvent.click(editButton());
    fireEvent.click(teacherBox());

    view.rerender(<SchoolHutLeaderKindsCard lodgeId="lodge-2" canEdit={false} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns when nothing is ticked", async () => {
    stubFetch();
    await renderCard(true);
    fireEvent.click(editButton());
    for (const label of [
      "The lodge custodian",
      "A member on the school booking",
      "A member staying separately",
    ]) {
      fireEvent.click(screen.getByLabelText(label));
    }
    expect(screen.getByText(/no hut leader can cover a school group/)).toBeTruthy();
  });
});
