// The Book on Behalf page's member and price-quote shapes, moved here
// verbatim from `../page.tsx` so the page shrinks below its length on main
// (#4926: a file past its hard ceiling can only stay or shrink). Types only.
import type { AgeTier } from "@prisma/client";

export interface FamilyMember {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  relationship: "self" | "partner" | "dependent";
}

export interface PriceQuote {
  guests: {
    ageTier: string;
    isMember: boolean;
    nights: number;
    priceCents: number;
  }[];
  totalPriceCents: number;
  availableCreditCents?: number;
}

export interface SelectedMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  // Set when the owner is an inline-created non-login NON_MEMBER (#1935): the
  // notify dialog defaults to "don't notify" and reworded, and a placeholder
  // (no-email) owner is never emailed at all.
  isNonMember?: boolean;
  isPlaceholderEmail?: boolean;
}
