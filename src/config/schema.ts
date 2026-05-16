import { z } from "zod";

const bedTypeSchema = z.enum(["dormitory", "private", "shared"]);

const bedSchema = z
  .object({
    id: z.string().trim().min(1, "bed id is required"),
    name: z.string().trim().min(1, "bed name is required"),
    capacity: z.number().int().positive("bed capacity must be a positive integer"),
    type: bedTypeSchema,
  })
  .strict();

const ageTierSchema = z
  .object({
    id: z.string().trim().min(1, "age tier id is required"),
    label: z.string().trim().min(1, "age tier label is required"),
    minAge: z.number().int().min(0, "minAge must be >= 0"),
    maxAge: z
      .number()
      .int()
      .min(0, "maxAge must be >= 0 when set")
      .nullable(),
    subscriptionRequiredForBooking: z.boolean(),
  })
  .strict()
  .refine(
    (tier) => tier.maxAge === null || tier.maxAge >= tier.minAge,
    { message: "maxAge must be >= minAge", path: ["maxAge"] },
  );

export const clubConfigSchema = z
  .object({
    name: z.string().trim().min(1, "club name is required"),
    shortName: z.string().trim().min(1).optional(),
    supportEmail: z.string().email("supportEmail must be a valid email"),
    contactEmail: z
      .string()
      .email("contactEmail must be a valid email")
      .optional(),
    publicUrl: z
      .string()
      .url("publicUrl must be a valid URL")
      .refine((url) => !url.endsWith("/"), {
        message: "publicUrl must not end with a trailing slash",
      }),
    emailFromName: z.string().trim().min(1, "emailFromName is required"),
    beds: z.array(bedSchema).min(1, "at least one bed is required"),
    ageTiers: z.array(ageTierSchema).min(1, "at least one age tier is required"),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const bedIds = new Set<string>();
    cfg.beds.forEach((bed, i) => {
      if (bedIds.has(bed.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate bed id "${bed.id}"`,
          path: ["beds", i, "id"],
        });
      }
      bedIds.add(bed.id);
    });

    const tierIds = new Set<string>();
    cfg.ageTiers.forEach((tier, i) => {
      if (tierIds.has(tier.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate age tier id "${tier.id}"`,
          path: ["ageTiers", i, "id"],
        });
      }
      tierIds.add(tier.id);
    });
  });

export type ClubConfig = z.infer<typeof clubConfigSchema>;
export type Bed = z.infer<typeof bedSchema>;
export type AgeTier = z.infer<typeof ageTierSchema>;

export const featureFlagsSchema = z
  .object({
    kiosk: z.boolean(),
    chores: z.boolean(),
    financeDashboard: z.boolean(),
    waitlist: z.boolean(),
    xeroIntegration: z.boolean(),
  })
  .strict();

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;
