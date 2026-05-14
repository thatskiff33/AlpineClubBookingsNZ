import { z } from "zod";
import logger from "@/lib/logger";
import {
  mapAddyAddressToSelection,
  type AddyAddressDetails,
  type AddressSelection,
} from "@/lib/addy-address";

const ADDY_API_BASE_URL = "https://api-nz.addysolutions.com";
const ADDY_CLIENT_VERSION = "tacbookings";

export const addySearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
  session: z
    .string()
    .trim()
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  expostbox: z.enum(["true", "false"]).optional(),
  exrural: z.enum(["true", "false"]).optional(),
  exundeliver: z.enum(["true", "false"]).optional(),
});

export const addyAddressIdSchema = z.string().trim().regex(/^\d{1,20}$/);

const addySearchResponseSchema = z.object({
  addresses: z
    .array(
      z.object({
        a: z.string(),
        id: z.union([z.string(), z.number()]),
      }),
    )
    .optional()
    .default([]),
});

export interface AddySuggestion {
  id: string;
  label: string;
}

function getAddyCredentials() {
  const apiKey = process.env.ADDY_API_KEY;
  const apiSecret = process.env.ADDY_API_SECRET;

  if (!apiKey || !apiSecret) {
    return null;
  }

  return { apiKey, apiSecret };
}

function getAddyHeaders(credentials: { apiKey: string; apiSecret: string }) {
  return {
    Accept: "application/json",
    "addy-api-key": credentials.apiKey,
    secret: credentials.apiSecret,
  };
}

function setBooleanFilter(
  url: URL,
  name: "expostbox" | "exrural" | "exundeliver",
  value: string | undefined,
) {
  if (value === "true") {
    url.searchParams.set(name, "true");
  }
}

export async function searchAddyAddresses(input: {
  q: string;
  session?: string;
  expostbox?: string;
  exrural?: string;
  exundeliver?: string;
}): Promise<{ suggestions: AddySuggestion[]; configured: boolean }> {
  const credentials = getAddyCredentials();

  if (!credentials) {
    return { suggestions: [], configured: false };
  }

  const url = new URL(`${ADDY_API_BASE_URL}/search`);
  url.searchParams.set("s", input.q);
  url.searchParams.set("max", "10");
  url.searchParams.set("v", ADDY_CLIENT_VERSION);
  if (input.session) {
    url.searchParams.set("session", input.session);
  }
  setBooleanFilter(url, "expostbox", input.expostbox);
  setBooleanFilter(url, "exrural", input.exrural);
  setBooleanFilter(url, "exundeliver", input.exundeliver);

  const response = await fetch(url, {
    cache: "no-store",
    headers: getAddyHeaders(credentials),
  });

  if (!response.ok) {
    logger.warn(
      { status: response.status },
      "Addy address search request failed",
    );
    throw new Error("Addy address search request failed");
  }

  const body = addySearchResponseSchema.parse(await response.json());

  return {
    configured: true,
    suggestions: body.addresses.map((address) => ({
      id: String(address.id),
      label: address.a,
    })),
  };
}

export async function getAddyAddressSelection(input: {
  id: string;
  session?: string;
}): Promise<{ selection: AddressSelection; configured: boolean }> {
  const credentials = getAddyCredentials();

  if (!credentials) {
    return {
      configured: false,
      selection: mapAddyAddressToSelection({}),
    };
  }

  const url = new URL(`${ADDY_API_BASE_URL}/address/${input.id}`);
  url.searchParams.set("v", ADDY_CLIENT_VERSION);
  if (input.session) {
    url.searchParams.set("session", input.session);
  }

  const response = await fetch(url, {
    cache: "no-store",
    headers: getAddyHeaders(credentials),
  });

  if (!response.ok) {
    logger.warn(
      { status: response.status },
      "Addy address details request failed",
    );
    throw new Error("Addy address details request failed");
  }

  return {
    configured: true,
    selection: mapAddyAddressToSelection(
      (await response.json()) as AddyAddressDetails,
    ),
  };
}
