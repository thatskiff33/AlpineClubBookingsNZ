// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BookingStayPreferences } from "../_components/booking-stay-preferences";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";
import type { EmailMessageSettings } from "@/lib/email-message-settings";

/**
 * INV-CAP-039: the arrival card prints one lodge's travel note and door code,
 * so its title says which lodge — the BOOKING's, never the club default.
 */
describe("the booking page's arrival card names the booking's lodge (INV-CAP-039)", () => {
  it("titles the card with the booking's own lodge", () => {
    render(
      <BookingStayPreferences
        booking={{ id: "bk-1", lodge: { name: "Second Lodge" } } as BookingDetailRecord}
        viewer={{} as BookingDetailViewer}
        access={{
          isDeleted: false,
          showArrivalTime: false,
          showRequestedRoom: false,
          showBedAllocationPanel: false,
        } as BookingDetailEditAccess}
        memberArrivalInstructions={{
          lodgeName: "Second Lodge",
          lodgeTravelNote: "Take the left fork after the bridge.",
          doorCode: null,
        } as EmailMessageSettings}
      />,
    );

    expect(
      screen.getByText("How to get to Second Lodge"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Take the left fork after the bridge."),
    ).toBeInTheDocument();
  });
});
