/**
 * Phone number formatting and parsing utilities.
 * Matches Xero's structured phone format (countryCode, areaCode, number).
 */

export interface StructuredPhone {
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string;
}

/**
 * Format structured phone fields into a display string.
 * e.g. { countryCode: "64", areaCode: "27", number: "4224115" } → "+64 27 4224115"
 */
export function formatMemberPhone(member: {
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
}): string | null {
  if (!member.phoneNumber) return null;
  const parts: string[] = [];
  if (member.phoneCountryCode) parts.push(`+${member.phoneCountryCode.replace(/^\+/, "")}`);
  if (member.phoneAreaCode) parts.push(member.phoneAreaCode);
  parts.push(member.phoneNumber);
  return parts.join(" ");
}

/**
 * Parse a single phone string into structured fields.
 * Supports formats like "+64 27 4224115", "027 4224115", "4224115".
 */
export function parsePhoneString(phone: string): StructuredPhone {
  const trimmed = phone.trim();
  if (!trimmed) {
    return { phoneCountryCode: null, phoneAreaCode: null, phoneNumber: "" };
  }

  // Pattern: +CC AC NUM (e.g. "+64 27 4224115")
  if (trimmed.startsWith("+")) {
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      return {
        phoneCountryCode: parts[0].replace(/^\+/, ""),
        phoneAreaCode: parts[1],
        phoneNumber: parts.slice(2).join(" "),
      };
    }
    if (parts.length === 2) {
      return {
        phoneCountryCode: parts[0].replace(/^\+/, ""),
        phoneAreaCode: null,
        phoneNumber: parts[1],
      };
    }
    // Just "+64" with no number — put it all in number
    return {
      phoneCountryCode: null,
      phoneAreaCode: null,
      phoneNumber: trimmed,
    };
  }

  // No country code — put entire value in phoneNumber
  return {
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: trimmed,
  };
}
