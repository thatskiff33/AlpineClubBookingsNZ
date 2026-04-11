import { z } from "zod";
import { AgeTier } from "@prisma/client";

/**
 * Shared Zod validator for the AgeTier enum.
 * Derived from Prisma's generated AgeTier enum so that adding a new tier
 * to schema.prisma automatically makes all validators accept it.
 */
export const ageTierEnum = z.nativeEnum(AgeTier);
