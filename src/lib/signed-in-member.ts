/**
 * The signed-in member's own row, read once per server-component render (#4938).
 *
 * The authenticated layout reads it for its gates (active, login allowed,
 * forced password change, two-factor, onboarding, nav roles) and the dashboard
 * beneath it reads it again for the induction card. Two `findUnique` calls on
 * one primary key, in one page load, cost two pool connections for the same
 * answer. Both now call `loadSignedInMember`, which React `cache()` memoises
 * for the render, so the page shares the layout's read.
 *
 * The select is the onboarding gate's, which stays the single definition of
 * the gate's fields, plus the scalars a page under the layout needs from the
 * same row. Only scalars belong here: every relation added is another query on
 * EVERY signed-in page, which is the cost this module exists to remove. A page
 * that needs a relation reads that table itself, keyed by the member id.
 *
 * Request-scoped only, like `auth()` and `loadEffectiveModuleFlags()`: nothing
 * survives the render, so a deactivation or role change is seen by the next
 * request. Outside a render `cache()` memoises nothing.
 */
import "server-only";

import { cache } from "react";

import { MEMBER_ONBOARDING_GATE_SELECT } from "@/lib/member-onboarding";
import { prisma } from "@/lib/prisma";

const SIGNED_IN_MEMBER_SELECT = {
  ...MEMBER_ONBOARDING_GATE_SELECT,
  // The dashboard's induction card.
  requiresInduction: true,
} as const;

export const loadSignedInMember = cache(async (memberId: string) =>
  prisma.member.findUnique({
    where: { id: memberId },
    select: SIGNED_IN_MEMBER_SELECT,
  }),
);
