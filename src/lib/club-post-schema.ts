/**
 * The request shapes of `/api/club-posts`, the club message board's member
 * door, shared with the AI app actions `list_message_board_posts` and
 * `post_to_message_board` (ALP-796, `INV-SSOT`).
 *
 * Client-safe: zod only, no Prisma and no `server-only`, so the catalogue can
 * import it.
 */
import { z } from "zod";

/** Matches the `ClubPost.content` column, so a body that fits here fits there. */
export const MAX_CLUB_POST_LENGTH = 4000;

/**
 * One page of the board. `before` and `beforeId` are the `cursor` the last
 * page answered with, passed back together; the route checks they are a pair
 * and that `before` is a date.
 */
export const clubPostListQuerySchema = z.object({
  before: z.string().max(40).optional(),
  beforeId: z.string().max(64).optional(),
});

/**
 * What an AI app connection may post: plain text and nothing else (ALP-796).
 * No rich body, so no pictures (a picture is uploaded in the browser and
 * named by the rich body), and never shared with other clubs: the catalogue
 * fixes `shareToAllClubs` to `false`, and the route refuses a connection that
 * sends anything else. The text's rules (length, control characters) are the
 * board's own, applied by the writer.
 */
export const clubPostConnectionCreateSchema = z
  .object({
    content: z.string(),
    shareToAllClubs: z.literal(false),
  })
  .strict();
