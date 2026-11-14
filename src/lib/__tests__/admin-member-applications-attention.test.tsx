// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRecoveryAlertToHoldFocus,
  installScrollIntoViewSpy,
  removeScrollIntoViewSpy,
} from "./helpers/focus";

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
}));
// Exercise the parent's callback contract without fetching the mapping editor's own data.
vi.mock(
  "@/app/(admin)/admin/membership/member-applications/_components/approval-mapping-panel",
  () => ({
    default: ({
      onRequestReview,
      onError,
    }: {
      onRequestReview: (payload: unknown) => void;
      onError: (error: string) => void;
    }) => (
      <>
        <button onClick={() => onRequestReview({ decision: "APPROVE" })}>
          Approve
        </button>
        <button onClick={() => onError("Mapping failed")}>Check mapping</button>
      </>
    ),
  }),
);
import MemberApplicationsPage from "@/app/(admin)/admin/membership/member-applications/page";

const application = {
  id: "application-1",
  applicantFirstName: "Test",
  applicantLastName: "Applicant",
  applicantEmail: "applicant@example.test",
  applicantDateOfBirth: null,
  applicantPhone: null,
  applicantAddress: {},
  familyMembers: [],
  familyMemberCount: 0,
  nominator1Email: "one@example.test",
  nominator2Email: "two@example.test",
  nominator1ConfirmedAt: null,
  nominator2ConfirmedAt: null,
  status: "PENDING_ADMIN",
  createdAt: "2026-07-01T00:00:00.000Z",
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
let scroll: ReturnType<typeof installScrollIntoViewSpy>;
const fetchMock = vi.fn();
beforeEach(() => {
  scroll = installScrollIntoViewSpy();
  fetchMock
    .mockReset()
    .mockResolvedValue(response({ applications: [application] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  removeScrollIntoViewSpy();
  vi.unstubAllGlobals();
});

async function openReview() {
  const button = await screen.findByRole("button", { name: "Approve" });
  button.focus();
  fireEvent.click(button);
  return screen.findByRole("button", { name: "Approve and email applicant" });
}

describe("Member Applications action attention", () => {
  it("keeps the error focused after a failing confirmation closes the real dialog", async () => {
    render(<MemberApplicationsPage />);
    const confirm = await openReview();
    fetchMock.mockResolvedValueOnce(
      response({ error: "Review failed" }, false),
    );
    fireEvent.click(confirm);
    const alert = document.getElementById("member-applications-error");
    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent("Review failed");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(scroll.mock.instances).toContain(alert);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("announces success and positions it once, without moving on a later filter reload", async () => {
    const scrollTo = vi.fn();
    const { container } = render(
      <div style={{ overflowY: "auto" }}>
        <MemberApplicationsPage />
      </div>,
    );
    Object.assign(container.firstElementChild!, { scrollTo });
    const status = screen
      .getAllByRole("status")
      .find((el) => el.id === "member-applications-success");
    expect(status).toBeEmptyDOMElement();
    const confirm = await openReview();
    fetchMock.mockResolvedValueOnce(response({}));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(status).toHaveTextContent("Application approved."),
    );
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    const filter = screen.getByRole("button", { name: "All" });
    filter.focus();
    fireEvent.click(filter);
    await screen.findByRole("button", { name: "Approve" });
    expect(document.activeElement).toBe(filter);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("refocuses an identical mapping-panel error on every attempt", async () => {
    render(<MemberApplicationsPage />);
    const button = await screen.findByRole("button", { name: "Check mapping" });
    const alert = document.getElementById("member-applications-error");
    expect(alert).toBeEmptyDOMElement();
    expect(alert).toHaveAttribute("role", "alert");
    for (let attempt = 0; attempt < 2; attempt++) {
      button.focus();
      fireEvent.click(button);
      await expectRecoveryAlertToHoldFocus(alert);
    }
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("retires an action error when the admin changes the filter, without moving focus", async () => {
    render(<MemberApplicationsPage />);
    const check = await screen.findByRole("button", { name: "Check mapping" });
    const alert = document.getElementById("member-applications-error");
    check.focus();
    fireEvent.click(check);
    await expectRecoveryAlertToHoldFocus(alert);
    expect(alert).toHaveTextContent("Mapping failed");
    const filter = screen.getByRole("button", { name: "All" });
    filter.focus();
    fireEvent.click(filter);
    await waitFor(() => expect(alert).toBeEmptyDOMElement());
    await screen.findByRole("button", { name: "Check mapping" });
    expect(document.activeElement).toBe(filter);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("does not move focus for a failed passive list load", async () => {
    fetchMock.mockResolvedValue(response({ error: "List unavailable" }, false));
    render(<MemberApplicationsPage />);
    await screen.findByText("List unavailable");
    expect(document.activeElement).toBe(document.body);
    expect(scroll).not.toHaveBeenCalled();
  });
});
