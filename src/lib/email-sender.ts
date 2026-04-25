const DEFAULT_EMAIL_FROM = "support@tokoroa.org.nz";

export const EMAIL_FROM = process.env.EMAIL_FROM || DEFAULT_EMAIL_FROM;
export const EMAIL_FROM_NAME =
  "Tokoroa Alpine Club - Online Booking System";

export function formatEmailFromAddress(fromAddress = EMAIL_FROM): string {
  return `"${EMAIL_FROM_NAME}" <${fromAddress}>`;
}
