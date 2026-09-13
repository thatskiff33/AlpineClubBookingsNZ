// @vitest-environment jsdom

/**
 * #2936 — the officer's correction form.
 *
 * The property worth a component test is the one the server cannot hold on its
 * own: an officer must not be able to SAVE a school correction without having
 * read which school the typed name resolves to. The server refuses a mismatched
 * acknowledgement, but a form that sent one automatically would turn that
 * refusal into a tick nobody read — so the tick has to be a real gate here too,
 * and it has to re-arm when the name changes underneath it.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookingRequestCorrectionEditor,
  type CorrectableBookingRequest,
} from "../booking-request-correction-editor";

const schoolRequest: CorrectableBookingRequest = {
  id: "req-1",
  type: "SCHOOL",
  version: 4,
  checkIn: "2026-08-10T00:00:00.000Z",
  checkOut: "2026-08-12T00:00:00.000Z",
  contactFirstName: "Ann",
  contactLastName: "Baker",
  contactEmail: "ann@example.test",
  contactPhone: "0211111111",
  schoolName: "Tokoroa Primary School",
  teachers: [{ firstName: "Ann", lastName: "Baker", email: "ann@example.test" }],
  cateringPreference: "QUOTE_BOTH",
  guests: [
    { firstName: "Ann", lastName: "Baker", ageTier: "ADULT" },
    { firstName: "School Child", lastName: "1", ageTier: "CHILD" },
  ],
  heldBookingId: null,
  linkedGuestMembers: [],
};

const knownRecord = {
  normalisedName: "Tokoroa Primary School",
  known: true,
  schoolRecordId: "org-7",
  schoolRecordName: "Tokoroa Primary School",
  schoolRecordArchived: false,
  schoolRecordHasXeroCustomer: true,
  currentContactNames: ["Bill Carter"],
  currentContactNamesTruncated: false,
};

const fetchMock = vi.fn();

function renderEditor(
  request: CorrectableBookingRequest = schoolRequest,
  handlers: { onCorrected?: () => void; onError?: () => void } = {},
) {
  return render(
    <BookingRequestCorrectionEditor
      request={request}
      disabled={false}
      onCorrected={handlers.onCorrected ?? vi.fn()}
      onError={handlers.onError ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("/school-record")) {
      return { ok: true, json: async () => ({ schoolRecord: knownRecord }) };
    }
    return {
      ok: true,
      json: async () => ({
        changedFields: ["checkIn"],
        holdOutcome: "none",
        supersededQuoteCount: 0,
        availability: { available: true, fullNights: [] },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openForm() {
  fireEvent.click(screen.getByRole("button", { name: "Correct this request" }));
  await waitFor(() =>
    expect(screen.getByLabelText("School name")).toBeInTheDocument(),
  );
}

describe("opening the form", () => {
  it("offers correction instead of the decline-and-resubmit it replaces", () => {
    renderEditor();
    expect(
      screen.getByText(/instead of declining it and asking them to start again/i),
    ).toBeInTheDocument();
  });

  it("says plainly that saving re-opens the request", async () => {
    renderEditor();
    await openForm();
    expect(
      screen.getByText(/any quote already sent is withdrawn/i),
    ).toBeInTheDocument();
  });

  it("seeds every field from the request the server last gave it", async () => {
    renderEditor();
    await openForm();
    expect(screen.getByLabelText("Check-in")).toHaveValue("2026-08-10");
    expect(screen.getByLabelText("Check-out")).toHaveValue("2026-08-12");
    expect(screen.getByLabelText("School name")).toHaveValue("Tokoroa Primary School");
    expect(screen.getByLabelText("Teacher 1 first name")).toHaveValue("Ann");
    // The child counts are derived from the stored party, not stored separately.
    expect(screen.getByLabelText("Children")).toHaveValue(1);
  });
});

describe("#3367: the school the name resolves to", () => {
  it("names the school the club already has, and its accounting customer", async () => {
    renderEditor();
    await openForm();
    await waitFor(() =>
      expect(
        screen.getByText(/using the accounting customer it already has/i),
      ).toBeInTheDocument(),
    );
    // And who approving would replace, since the teachers above become the
    // school's contacts.
    expect(screen.getByText(/Bill Carter/)).toBeInTheDocument();
  });

  it("warns that an unrecognised name creates a new school and a new customer", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/school-record")) {
        return {
          ok: true,
          json: async () => ({
            schoolRecord: { ...knownRecord, known: false, schoolRecordId: null },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    renderEditor();
    await openForm();
    await waitFor(() =>
      expect(
        screen.getByText(/add it as a new school, with a new accounting customer/i),
      ).toBeInTheDocument(),
    );
  });

  it("keeps Save disabled until the officer confirms which school it is", async () => {
    renderEditor();
    await openForm();
    fireEvent.change(screen.getByLabelText("Check-in"), {
      target: { value: "2026-08-17" },
    });
    fireEvent.change(screen.getByLabelText("Why are you correcting it?"), {
      target: { value: "The school rang about the dates." },
    });
    await waitFor(() =>
      expect(screen.getByText("Yes, this is that school.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();
  });

  it("takes the confirmation back when the name changes underneath it", async () => {
    // The defect this prevents: confirm one school, retype the name, and save a
    // consequence nobody read. The server refuses it too, but only because the
    // form still sends what it was last shown.
    renderEditor();
    await openForm();
    fireEvent.change(screen.getByLabelText("Why are you correcting it?"), {
      target: { value: "Name was misspelt." },
    });
    await waitFor(() =>
      expect(screen.getByText("Yes, this is that school.")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();

    fireEvent.change(screen.getByLabelText("School name"), {
      target: { value: "Tokoroa Primary" },
    });
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
  });
});

describe("saving", () => {
  it("posts the officer's confirmation alongside the corrected details", async () => {
    const onCorrected = vi.fn();
    renderEditor(schoolRequest, { onCorrected });
    await openForm();
    fireEvent.change(screen.getByLabelText("Check-in"), {
      target: { value: "2026-08-17" },
    });
    fireEvent.change(screen.getByLabelText("Check-out"), {
      target: { value: "2026-08-19" },
    });
    fireEvent.change(screen.getByLabelText("Why are you correcting it?"), {
      target: { value: "The school rang about the dates." },
    });
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(onCorrected).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    )!;
    expect(String(post[0])).toBe("/api/admin/booking-requests/req-1/correct");
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body.expectedVersion).toBe(4);
    expect(body.checkIn).toBe("2026-08-17");
    expect(body.checkOut).toBe("2026-08-19");
    expect(body.school.schoolRecord).toEqual({
      outcome: "existing",
      schoolRecordId: "org-7",
    });
    // A school correction never sends a hand-edited guest list: the party is
    // rebuilt server-side from the teachers and the counts.
    expect(body.guests).toBeUndefined();
  });

  it("reports a correction that saved but could not free its beds as SAVED", async () => {
    // The difference between the officer re-typing the whole form and the
    // officer releasing a hold.
    const onCorrected = vi.fn();
    const onError = vi.fn();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/school-record")) {
        return { ok: true, json: async () => ({ schoolRecord: knownRecord }) };
      }
      return {
        ok: false,
        json: async () => ({
          error: "The correction was saved, but this request's held beds…",
          corrected: true,
          holdReleasePending: true,
        }),
      };
    });
    renderEditor({ ...schoolRequest, heldBookingId: "held-1" }, {
      onCorrected,
      onError,
    });
    await openForm();
    expect(screen.getByText(/releases them, and the requester/i)).toBeInTheDocument();
    // The warning must not over-promise: a catering-only correction keeps the
    // beds, and an officer told otherwise would go looking for a hold that is
    // still there.
    expect(
      screen.getByText(/Changing only the catering preference keeps the beds/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Why are you correcting it?"), {
      target: { value: "Dates moved." },
    });
    fireEvent.change(screen.getByLabelText("Check-in"), {
      target: { value: "2026-08-17" },
    });
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onCorrected).toHaveBeenCalledWith(
      expect.stringMatching(/Correction saved/),
    );
  });
});

describe("a general request", () => {
  const generalRequest: CorrectableBookingRequest = {
    ...schoolRequest,
    type: "GENERAL",
    schoolName: null,
    teachers: [],
    cateringPreference: null,
  };

  it("edits the guest list directly and asks no school question", async () => {
    renderEditor(generalRequest);
    fireEvent.click(screen.getByRole("button", { name: "Correct this request" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Guest 1 first name")).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("School name")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/school-record")),
    ).toBe(false);
  });

  it("arms Save on the reason alone, with no school to confirm", async () => {
    renderEditor(generalRequest);
    fireEvent.click(screen.getByRole("button", { name: "Correct this request" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Guest 1 first name")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why are you correcting it?"), {
      target: { value: "Guest dropped out." },
    });
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();
  });
});

describe("member links keyed to the party", () => {
  const linkedRequest: CorrectableBookingRequest = {
    ...schoolRequest,
    linkedGuestMembers: [{ guestIndex: 1, memberId: "member-42" }],
  };

  it("warns that changing the group clears the links, before anything is saved", async () => {
    renderEditor(linkedRequest);
    await openForm();
    expect(
      screen.getByText(/linked to a club member/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/link the right people again before you price/i),
    ).toBeInTheDocument();
  });

  it("says how many links the save cleared, so the officer re-links", async () => {
    const onCorrected = vi.fn();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/school-record")) {
        return { ok: true, json: async () => ({ schoolRecord: knownRecord }) };
      }
      return {
        ok: true,
        json: async () => ({
          changedFields: ["guests"],
          holdOutcome: "none",
          supersededQuoteCount: 0,
          clearedMemberLinkCount: 1,
          availability: { available: true, fullNights: [] },
        }),
      };
    });
    renderEditor(linkedRequest, { onCorrected });
    await openForm();
    fireEvent.change(screen.getByLabelText("Why are you correcting it?"), {
      target: { value: "A teacher dropped out." },
    });
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(onCorrected).toHaveBeenCalled());
    expect(onCorrected).toHaveBeenCalledWith(
      expect.stringMatching(/1 member link was cleared — link them again before quoting/),
    );
  });

  it("says nothing about links when the request has none", async () => {
    renderEditor();
    await openForm();
    expect(screen.queryByText(/linked to a club member/i)).not.toBeInTheDocument();
  });
});

describe("the version fence is only a fence if it is the version you were shown", () => {
  it("sends the version the FIELDS were seeded from, not the one that arrived later", async () => {
    // The defect: this card sits in a queue that refetches on any action
    // anywhere in it, so `request.version` advances underneath an open form as
    // a matter of routine. Reading it at save time handed the server the NEW
    // version with the OLD fields — which passes every fence there is, and
    // silently clobbers whatever moved the row, including a second officer's
    // correction.
    const onCorrected = vi.fn();
    const { rerender } = renderEditor(schoolRequest, { onCorrected });
    await openForm();
    fireEvent.change(screen.getByLabelText("Why are you correcting it?"), {
      target: { value: "The school rang about the dates." },
    });
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox"));

    // Something else in the queue moved the request while this form was open.
    rerender(
      <BookingRequestCorrectionEditor
        request={{ ...schoolRequest, version: 9 }}
        disabled={false}
        onCorrected={onCorrected}
        onError={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(onCorrected).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    )!;
    const body = JSON.parse(String((post[1] as RequestInit).body));
    expect(body.expectedVersion).toBe(4);
  });
});

describe("what the card promises about the beds", () => {
  it("does not promise a bed release in the paragraph that cannot know", async () => {
    // The header used to say, unconditionally, that saving releases any beds
    // held — while the paragraph below it explained that a catering-only
    // correction keeps them. Two contradictory statements on one screen.
    renderEditor();
    await openForm();
    expect(
      screen.getByText(/any quote already sent is withdrawn/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/beds held for the old details are released/i),
    ).not.toBeInTheDocument();
  });

  it("offers the catering escape hatch only where a catering control exists", async () => {
    // A public request has no catering preference at all, so telling its
    // officer that changing only the catering keeps the beds points at a field
    // that is not on the screen.
    renderEditor({
      ...schoolRequest,
      type: "GENERAL",
      schoolName: null,
      teachers: [],
      cateringPreference: null,
      heldBookingId: "held-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Correct this request" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Guest 1 first name")).toBeInTheDocument(),
    );
    expect(screen.getByText(/This request is holding beds/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Changing only the catering preference/i),
    ).not.toBeInTheDocument();
  });

  it("keeps the catering escape hatch on a school request that holds beds", async () => {
    renderEditor({ ...schoolRequest, heldBookingId: "held-1" });
    await openForm();
    expect(
      screen.getByText(/Changing only the catering preference keeps the beds/i),
    ).toBeInTheDocument();
  });
});

describe("when the school lookup cannot answer", () => {
  it("says so and offers a retry instead of checking for ever", async () => {
    // The defect: any lookup error left the card saying "Checking which school
    // this is…" permanently, with Save disabled and nothing to press. The only
    // way out was to reload the whole queue.
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/school-record")) {
        attempts += 1;
        if (attempts === 1) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ schoolRecord: knownRecord }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    renderEditor();
    await openForm();
    await waitFor(() =>
      expect(screen.getByText(/could not check which school this is/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByText("Yes, this is that school.")).toBeInTheDocument(),
    );
  });

  it("does not claim to be checking when there is no name to check", async () => {
    renderEditor();
    await openForm();
    fireEvent.change(screen.getByLabelText("School name"), {
      target: { value: "  " },
    });
    await waitFor(() =>
      expect(
        screen.getByText(/Type the school's name and we will tell you/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/Checking which school this is/i),
    ).not.toBeInTheDocument();
  });
});
