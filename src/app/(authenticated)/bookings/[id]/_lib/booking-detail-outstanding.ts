import "server-only";
import { prisma } from "@/lib/prisma";
import type { requireActiveSessionUser } from "@/lib/session-guards";
import { MEMBER_PRIVILEGE_CHECK_SELECT } from "@/lib/access-role-definitions";
import { sessionAccessRoleClaim } from "@/lib/access-roles";
import { getAdminPermissionMatrix } from "@/lib/admin-permissions";
import { additionalAskCause } from "@/lib/additional-ask-cause";
import { bookingOwner } from "@/lib/booking-owner";
import { isAdditionalPaymentDoorOpenForBooking } from "@/lib/additional-payment-chase";
import { bookingOutstandingCardCents, type BookingOutstandingPaymentView } from "@/lib/booking-outstanding-payment";
import { readBookingSupplementaryInvoiceIdentities } from "@/lib/booking-supplementary-invoice-identities";
import { loadEffectiveModuleFlagsStrict } from "@/lib/module-settings";
import { getXeroConnectionStatus } from "@/lib/xero-token-store";
import { getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { INVOICE_OBSERVATION_BATCH_SIZE, readXeroInvoicePayableObservations } from "@/lib/xero-invoice-observation-read";
import { checkRateLimit, rateLimiters } from "@/lib/rate-limit";
import { createInvoiceObservationCursor, readInvoiceObservationCursor } from "@/lib/booking-invoice-observation-cursor";
import { getClubFormat } from "@/lib/club-format-settings";
import { stableDigest } from "@/lib/stable-digest";
import { loadBookingDetail } from "./load-booking-detail";
import { resolveBookingDetailViewer } from "./booking-detail-viewer";

/** No render cache: each provider/action boundary re-reads current authority. */
const stateDependencies = {
  session: async () => (await import("@/lib/auth")).auth(),
  active: async (...args: Parameters<typeof requireActiveSessionUser>) => (await import("@/lib/session-guards")).requireActiveSessionUser(...args),
  modules: loadEffectiveModuleFlagsStrict, connection: getXeroConnectionStatus, format: getClubFormat,
};
export async function loadBookingOutstandingState(bookingId: string, actorId: string, reads = stateDependencies) {
  const session = await reads.session();
  if (!session || session.user.id !== actorId || await reads.active(actorId, { sessionUser: session.user })) return null;
  const [booking, member] = await Promise.all([
    loadBookingDetail(bookingId),
    prisma.member.findUnique({ where: { id: actorId }, select: MEMBER_PRIVILEGE_CHECK_SELECT }),
  ]);
  if (!booking || !member) return null;
  const currentSession = { ...session, user: { ...session.user, canLogin: member.canLogin,
    accessRoles: sessionAccessRoleClaim(member), adminPermissionMatrix: getAdminPermissionMatrix(member) } };
  const viewer = resolveBookingDetailViewer({ session: currentSession, booking });
  if ((!viewer.canManageBooking && !viewer.isLinkedGuestViewer && !viewer.canViewAsAdmin) || (booking.deletedAt && !viewer.isAdmin)) return null;
  const collectable = viewer.canSeeOwnerCredit &&
    isAdditionalPaymentDoorOpenForBooking({ bookingStatus: booking.status, bookingDeletedAt: booking.deletedAt });
  // Privacy/lifecycle gate is before identity, token and provider work.
  if (!collectable) return { booking, viewer, collectable, identities: null, tenantId: null, providerEligible: false, format: null, modules: null, revision: "" };
  const [identities, modules, connection, format] = await Promise.all([
    readBookingSupplementaryInvoiceIdentities(bookingId), reads.modules(), reads.connection(), reads.format(),
  ]);
  const tenantId = connection.connected ? connection.tenantId : null;
  const providerEligible = modules.xeroIntegration && tenantId !== null && !booking.organiserSettled;
  const revision = stableDigest({ identities: identities.revision, tenantId, providerEligible,
    owner: bookingOwner(booking).memberId, organiserSettled: booking.organiserSettled,
    audience: viewer.isBookingOwner ? "owner" : "officer", currencyCode: format.currencyCode });
  return { booking, viewer, collectable, identities, tenantId, providerEligible, format, modules, revision };
}

type OutstandingState = NonNullable<Awaited<ReturnType<typeof loadBookingOutstandingState>>>;
const defaultDependencies = {
  loadState: loadBookingOutstandingState,
  authenticate: getAuthenticatedXeroClient,
  readInvoices: readXeroInvoicePayableObservations,
  limit: (actorId: string) => checkRateLimit(rateLimiters.bookingQuery, `booking-supplementary-observation:${actorId}`),
};

function viewFor(state: OutstandingState): BookingOutstandingPaymentView {
  if (!state.collectable || !state.identities) return { kind: "hidden" };
  return { kind: "ready", audience: state.viewer.isBookingOwner ? "owner" : "officer", bookingStatus: state.booking.status, revision: state.revision,
    cardDueCents: bookingOutstandingCardCents(state.booking),
    askCause: additionalAskCause(state.booking.payment?.transactions ?? []),
    cardRevision: stableDigest({ intent: state.booking.payment?.additionalPaymentIntentId, amount: state.booking.payment?.additionalAmountCents, status: state.booking.payment?.additionalPaymentStatus }), observations: [],
    incomplete: state.identities.incomplete, nextCursor: null };
}

/** One bounded read action; continuation repeats the same authorization and post-wait fences. */
export async function readBookingOutstandingAction(bookingId: string, actorId: string, cursor?: string,
  deps = defaultDependencies,
): Promise<{ view: BookingOutstandingPaymentView; state: OutstandingState | null }> {
  let state = await deps.loadState(bookingId, actorId);
  if (!state) return { view: { kind: "hidden" }, state: null };
  let view = viewFor(state);
  if (view.kind === "hidden" || !state.identities) return { view, state };
  const initialRevision = state.revision;
  const ids = state.identities.invoiceIds;
  if (!ids.length) return { view, state };
  if (!state.providerEligible || !state.tenantId || !state.format) return { view: { ...view, incomplete: true }, state };
  const scope = { actorId, bookingId, tenantId: state.tenantId, revision: state.revision };
  const offset = cursor ? readInvoiceObservationCursor(cursor, scope, ids.length) : 0;
  if (offset === null) return { view: { ...view, incomplete: true }, state };
  try {
    if (!(await deps.limit(actorId)).success) return { view: { ...view, incomplete: true }, state };
    const authenticated = await deps.authenticate();
    // Auth may refresh/wait on its existing lease, outside the accounting budget.
    state = await deps.loadState(bookingId, actorId);
    if (!state) return { view: { kind: "hidden" }, state: null };
    view = viewFor(state);
    if (view.kind === "hidden") return { view, state };
    if (state.revision !== initialRevision || authenticated.tenantId !== scope.tenantId || !state.providerEligible || !state.format) {
      return { view: { ...view, incomplete: true }, state };
    }
    const batch = ids.slice(offset, offset + INVOICE_OBSERVATION_BATCH_SIZE);
    const observations = await deps.readInvoices({ ...authenticated, invoiceIds: batch, currencyCode: state.format.currencyCode });
    state = await deps.loadState(bookingId, actorId);
    if (!state) return { view: { kind: "hidden" }, state: null };
    view = viewFor(state); // includes a newly captured/withdrawn card ask and current audience
    if (view.kind === "hidden") return { view, state };
    if (state.revision !== initialRevision || !state.providerEligible) return { view: { ...view, incomplete: true }, state };
    const nextOffset = offset + batch.length;
    return { state, view: { ...view, observations,
      nextCursor: nextOffset < ids.length ? createInvoiceObservationCursor(scope, nextOffset) : null } };
  } catch {
    // A failed provider/auth read is still fenced against cancellation and permission changes.
    state = await deps.loadState(bookingId, actorId);
    if (!state) return { view: { kind: "hidden" }, state: null };
    view = viewFor(state);
    return { state, view: view.kind === "ready" ? { ...view, incomplete: true } : view };
  }
}
