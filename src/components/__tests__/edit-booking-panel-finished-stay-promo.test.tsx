// @vitest-environment jsdom
/**
 * #4533: on a FINISHED stay, Edit Booking's Save cannot apply a promo code —
 * the stay's corrections run inside the change-request approval (#3750). It
 * used to validate the code, show the discount, and then do nothing on Save.
 * Now the panel says why, keeps Save off, and sends the code as a promo
 * correction request that opens in the queue.
 *
 * Frozen clock discipline: a June 2026 stay, before the 2026-07-01 freeze.
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";
import { FINISHED_STAY_SAVE_LOCKED_MESSAGE } from "@/components/edit-booking/finished-stay-promo-correction-card";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: routerPush }),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const requestBodies: Array<Record<string, unknown>> = [];
/** What the change-request route answers; a test may replace it. */
let changeRequestReply: () => Response;

function installFetch() {
  requestBodies.length = 0;
  changeRequestReply = () => jsonResponse({ id: "request-4533", status: "REQUESTED" }, 201);
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.includes("/api/members/family")) return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/api/promo-codes/guest-codes")) return jsonResponse({ multiPromoCodes: false, guests: [] });
    if (url.includes("/api/promo-codes/available")) return jsonResponse([]);
    if (url.includes("/api/promo-codes/validate")) {
      return jsonResponse({
        valid: true,
        code: body.code,
        description: null,
        type: "FREE_NIGHTS",
        discountCents: 5000,
        promoAdjustmentCents: -5000,
        totalPriceCents: 30000,
        finalPriceCents: 25000,
      });
    }
    // The ordinary quote refuses a finished stay, as the real route does.
    if (url.includes("/modify-quote")) {
      return jsonResponse({ error: "This booking has no future nights available for self-service changes" }, 400);
    }
    if (url.includes("/change-requests")) {
      requestBodies.push(body);
      return changeRequestReply();
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking(editPolicyExtra: Record<string, unknown>) {
  return {
    id: "bk-4533",
    checkIn: "2026-06-10",
    checkOut: "2026-06-16",
    guests: [
      {
        id: "g1",
        firstName: "Ann",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: "2026-06-10",
        stayEnd: "2026-06-16",
        nights: null,
        priceCents: 30000,
      },
    ],
    viewerRole: "ADMIN",
    memberId: "member-1",
    finalPriceCents: 30000,
    totalPriceCents: 30000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: false,
    canFixNonMemberGuestNameTypos: false,
    editPolicy: {
      mode: null,
      today: "2026-07-01",
      editableFrom: null,
      checkInEditable: false,
      adminOverrideAvailable: true,
      ...editPolicyExtra,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

async function applyCode(code: string) {
  fireEvent.change(await screen.findByPlaceholderText("Enter promo code"), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
}

beforeEach(() => {
  installFetch();
  routerPush.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel on a finished stay (#4533)", () => {
  it("says why Save cannot apply a promo code, and sends it as a correction request", async () => {
    render(
      <EditBookingPanel booking={makeBooking({ finishedStayPromoCorrection: true })} canAdminOverride onDone={vi.fn()} />,
    );
    await applyCode("FREENIGHT");

    expect(await screen.findByText(FINISHED_STAY_SAVE_LOCKED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Send as a promo correction request" }));
    await waitFor(() => expect(requestBodies).toHaveLength(1));
    expect(requestBodies[0]).toEqual({ promoChange: { promoCode: "FREENIGHT" } });
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/admin/booking-requests?tab=changes&requestId=request-4533"),
    );
  });

  it("says the server's reason when the request is refused, without leaving the page", async () => {
    changeRequestReply = () =>
      jsonResponse({ error: "This booking already carries that promo code, so there is nothing to correct." }, 400);
    render(
      <EditBookingPanel booking={makeBooking({ finishedStayPromoCorrection: true })} canAdminOverride onDone={vi.fn()} />,
    );
    await applyCode("FREENIGHT");
    fireEvent.click(await screen.findByRole("button", { name: "Send as a promo correction request" }));
    const card = await screen.findByTestId("finished-stay-promo-correction");
    await waitFor(() => expect(within(card).getByRole("alert")).toHaveTextContent("nothing to correct"));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("offers nothing new on a stay that has not been flagged as a finished-stay correction", async () => {
    render(<EditBookingPanel booking={makeBooking({})} canAdminOverride onDone={vi.fn()} />);
    await applyCode("FREENIGHT");
    await screen.findByPlaceholderText("Enter promo code");
    expect(screen.queryByTestId("finished-stay-promo-correction")).not.toBeInTheDocument();
  });
});

