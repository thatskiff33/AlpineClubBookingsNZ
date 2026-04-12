import { AgeTier } from "@prisma/client";
import { z } from "zod";

/**
 * Shared Zod validator for the AgeTier enum.
 * Derived from Prisma's generated AgeTier enum so that adding a new tier
 * to schema.prisma automatically makes all validators accept it.
 */
export const AGE_TIER_VALUES = Object.values(AgeTier) as [
  AgeTier,
  ...AgeTier[],
];

export const ageTierEnum = z.nativeEnum(AgeTier);
