export function formatXeroPhone(phone: {
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
}): string | null {
  if (!phone.phoneNumber) return null;

  const parts: string[] = [];
  if (phone.phoneCountryCode) {
    parts.push(`+${phone.phoneCountryCode.replace(/^\+/, "")}`);
  }
  if (phone.phoneAreaCode) {
    parts.push(phone.phoneAreaCode);
  }
  parts.push(phone.phoneNumber);

  return parts.join(" ");
}
