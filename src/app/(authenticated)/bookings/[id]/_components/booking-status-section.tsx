import { cache, type ComponentProps } from "react";
import { readBookingOutstandingAction } from "../_lib/booking-detail-outstanding";
import { hasOutstandingCollectionEvidence } from "@/lib/booking-outstanding-payment";
import { loadBookingDetailHistory } from "../_lib/booking-detail-history";
import { BookingStatusBanners } from "./booking-status-banners";
import { BookingOutstandingPayments } from "./booking-outstanding-payments";
import { bindClubFormat } from "@/lib/club-format-bound";
import { stableDigest } from "@/lib/stable-digest";
import { resolveBookingDetailLinkedParty } from "../_lib/booking-detail-linked-party";
import { resolveBookingDetailPayment } from "../_lib/booking-detail-payment";
import { loadSupersededHeldBackCents } from "../_lib/booking-detail-organiser-card-appeal";
import { renderBookingDetailMessages } from "../_lib/booking-detail-messages";

// One read action per server render, never a cross-request observation cache.
const readOutstanding = cache((bookingId: string, actorId: string) => readBookingOutstandingAction(bookingId, actorId));

export async function BookingStatusSection(props: ComponentProps<typeof BookingStatusBanners> & { actorId: string } &
  Pick<Parameters<typeof renderBookingDetailMessages>[0], "modules" | "bookingMessages" | "bookingLodgeEmailSettings">) {
  const result = await readOutstanding(props.booking.id, props.actorId).catch(() => null);
  if (!result) return <p className="text-sm">Additional amounts and payment instructions cannot yet be confirmed. Please check this booking again or contact the club.</p>;
  const { state, view } = result;
  if (!state) return null;
  const money = state.format ? bindClubFormat(state.format) : props.money;
  const history = await loadBookingDetailHistory({ booking: state.booking, viewer: state.viewer, club: props.club,
    format: money.format, additionalCollectionPending: hasOutstandingCollectionEvidence(view) });
  const modules = state.modules ?? props.modules;
  const access = { ...props.access, isDeleted: state.booking.deletedAt !== null };
  const party = resolveBookingDetailLinkedParty({ booking: state.booking, modules, viewer: state.viewer, access });
  const supersededHeldBackCents = await loadSupersededHeldBackCents(state.booking);
  const payment = resolveBookingDetailPayment({ booking: state.booking, modules, viewer: state.viewer, access, party, amountOwed: history.amountOwed, supersededHeldBackCents });
  const messages = renderBookingDetailMessages({ booking: state.booking, club: props.club, money, modules,
    bookingMessages: props.bookingMessages, bookingLodgeEmailSettings: props.bookingLodgeEmailSettings, payment });
  return <>
    <BookingStatusBanners booking={state.booking} club={props.club} money={money} viewer={state.viewer} history={history}
      access={access} party={party} payment={payment} messages={messages} />
    <BookingOutstandingPayments key={stableDigest(view)} bookingId={state.booking.id} initial={view} format={money.format} zone={props.club.zone} />
  </>;
}
