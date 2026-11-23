/**
 * Requests of `src/app/api/members/partner-link/route.ts` (#1742, ALP-795).
 *
 * The route parses with these, and the AI app action catalogue describes the
 * same actions with them (`INV-SSOT`). Pure zod: no server imports.
 */
import { z } from "zod";

/**
 * `POST`: declare a partner by email (any registered login adult, who
 * confirms from their profile) or by the id of a member of the requester's
 * own family group. Exactly one of the two.
 */
export const partnerLinkRequestSchema = z
  .object({
    email: z.string().email("Invalid email address").optional(),
    memberId: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.email) !== Boolean(data.memberId), {
    message: "Provide either an email or a family member",
  });

/** `PUT`: confirm or decline a pending request addressed to the member. */
export const partnerLinkRespondSchema = z.object({
  linkId: z.string().min(1),
  action: z.enum(["accept", "decline"]),
});

/** A query value, trimmed; blank reads as not sent. */
const optionalId = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

/**
 * `DELETE`: `id` withdraws the member's own pending request or ends their
 * confirmed partnership; `inviteTokenId` cancels a partner invitation they
 * emailed that nobody has claimed. Exactly one of the two, which the route
 * checks so it can say which is missing.
 */
export const partnerLinkDeleteQuerySchema = z.object({
  id: optionalId,
  inviteTokenId: optionalId,
});
