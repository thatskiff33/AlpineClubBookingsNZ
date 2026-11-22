/**
 * The `[id]` segment of an admin record route, as an AI app action describes
 * it (ALP-721). The dispatcher also refuses anything but one record id in an
 * address segment, so a value cannot move the call to another route.
 */
import { z } from "zod";

export const recordIdParamsSchema = z.object({ id: z.string().min(1) });
