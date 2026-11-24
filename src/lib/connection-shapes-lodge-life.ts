/**
 * What each lodge-life AI app action returns (ALP-796, `INV-MCP-006`): split
 * from `connection-shapes.ts` to keep each module within its size budget. The
 * one place a catalogue entry's `returns` and its route's projection both read
 * (`INV-SSOT`).
 *
 * Types only from the route modules: nothing here reaches the database.
 */
import type { CalendarEventDTO } from "@/lib/calendar-events";
import type { ClubPostPage } from "@/lib/club-posts";
import { completeConnectionShapeFor, connectionShapeFor, type ConnectionShape } from "@/lib/connection-projection";
import type { FoodOrderHistory } from "@/lib/food-orders";
import type { MemberInductionView } from "@/lib/induction";
import type { PublicMaintenanceQuestion } from "@/lib/maintenance-reports";
import type { MemberWorkPartyDTO } from "@/lib/work-party-member";

/** The events a member sees, without the series bookkeeping or whether they may edit. */
export const CALENDAR_EVENTS_CONNECTION_SHAPE = connectionShapeFor<{
  events: CalendarEventDTO[];
  canManage: boolean;
}>({
  events: {
    id: true,
    title: true,
    location: true,
    details: true,
    allDay: true,
    startsAt: true,
    endsAt: true,
    isMeeting: true,
    recurrence: { frequency: true, interval: true, endMode: true, until: true, count: true },
    workPartyEventId: true,
  },
});

/**
 * One page of the message board as plain text. Never the author's member id
 * or the rich body, whose picture addresses the app has no use for.
 */
export const CLUB_POST_PAGE_CONNECTION_SHAPE = connectionShapeFor<ClubPostPage>({
  posts: {
    id: true,
    authorName: true,
    content: true,
    sharedToAllClubs: true,
    postedAt: true,
    mine: true,
    originClubName: true,
  },
  cursor: { before: true, beforeId: true },
});

/** A new post, food order or maintenance report: its id. */
const CREATED_RECORD_SHAPE = connectionShapeFor<{ id: string }>({ id: true });
export const CLUB_POST_CREATED_CONNECTION_SHAPE: ConnectionShape = CREATED_RECORD_SHAPE;
export const FOOD_ORDER_CREATED_CONNECTION_SHAPE: ConnectionShape = CREATED_RECORD_SHAPE;
export const MAINTENANCE_REPORT_CREATED_CONNECTION_SHAPE: ConnectionShape = CREATED_RECORD_SHAPE;

/** What the order form needs. The food officer's address is never in the answer. */
export const FOOD_ORDER_OPTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  ready: boolean;
  officerLabel: string;
  lodges: Array<{ id: string; name: string }>;
  today: string;
  units: readonly string[];
  limits: { maxItems: number; descriptionMaxLength: number; quantityMax: number; notesMaxLength: number };
}>({
  ready: true,
  officerLabel: true,
  lodges: { id: true, name: true },
  today: true,
  units: true,
  limits: { maxItems: true, descriptionMaxLength: true, quantityMax: true, notesMaxLength: true },
});

/**
 * The member's own orders and their totals. Not who ticked or priced an order
 * (other people's names), the management flags, or the officer page's lodge
 * list and email link.
 */
export const FOOD_ORDER_HISTORY_CONNECTION_SHAPE = connectionShapeFor<FoodOrderHistory>({
  orders: {
    id: true,
    lodgeId: true,
    lodgeName: true,
    neededBy: true,
    notes: true,
    status: true,
    items: { description: true, quantity: true, unit: true, receivedAt: true },
    receivedAt: true,
    priceCents: true,
    createdAt: true,
  },
  page: true,
  pageSize: true,
  orderCount: true,
  pricedCount: true,
  priceTotalCents: true,
});

/**
 * The member's own induction: where it stands, the checklist, and who has
 * signed. Not the signers' comments, the final or voiding comments, or the
 * checklist's competency and notes prompts (health, safety and competency
 * notes stay on the website).
 */
const MEMBER_INDUCTION_SHAPE = connectionShapeFor<MemberInductionView>({
  id: true,
  kind: true,
  status: true,
  requiredSignOffs: true,
  inductionDate: true,
  completedAt: true,
  createdAt: true,
  template: {
    name: true,
    sections: {
      title: true,
      description: true,
      items: { label: true, isMandatory: true, requiresDemonstration: true },
    },
  },
  signOffs: { signerName: true, signerRole: true, signedAt: true },
  assignedSigners: { firstName: true, lastName: true },
});

export const MEMBER_OWN_INDUCTION_CONNECTION_SHAPE: ConnectionShape = { own: MEMBER_INDUCTION_SHAPE };
export const MEMBER_INDUCTION_CONNECTION_SHAPE: ConnectionShape = { induction: MEMBER_INDUCTION_SHAPE };

/** A work party as a member sees it (`MemberWorkPartyDTO`): never the internal promo code. */
const MEMBER_WORK_PARTY_SHAPE = completeConnectionShapeFor<MemberWorkPartyDTO>({
  id: true,
  name: true,
  description: true,
  startDate: true,
  endDate: true,
  discountPercent: true,
  lodgeId: true,
  lodgeName: true,
  join: { checkIn: true, checkOut: true },
});

export const MEMBER_WORK_PARTY_LIST_CONNECTION_SHAPE: ConnectionShape = { workParties: MEMBER_WORK_PARTY_SHAPE };
export const MEMBER_WORK_PARTY_CONNECTION_SHAPE: ConnectionShape = { workParty: MEMBER_WORK_PARTY_SHAPE };

export const WORK_PARTIES_FOR_STAY_CONNECTION_SHAPE = connectionShapeFor<{
  events: Array<{
    id: string;
    name: string;
    description: string | null;
    startDate: string;
    endDate: string;
    discountPercent: number;
    lodgeName: string | null;
  }>;
}>({
  events: {
    id: true,
    name: true,
    description: true,
    startDate: true,
    endDate: true,
    discountPercent: true,
    lodgeName: true,
  },
});

/** The questions and lodges to report against. Not whether photos are on: a connection cannot attach one. */
export const MAINTENANCE_REPORT_FORM_CONNECTION_SHAPE = connectionShapeFor<{
  questions: PublicMaintenanceQuestion[];
  lodges: Array<{ id: string; name: string; isDefault: boolean }>;
  photosEnabled: boolean;
  summaryMaxLength: number;
}>({
  questions: { id: true, label: true, helpText: true, type: true, required: true, choices: true, sortOrder: true },
  lodges: { id: true, name: true, isDefault: true },
  summaryMaxLength: true,
});
