/**
 * The WebAuthn relying party (#4617, INV-AUTH-009, INV-CONFIG-001).
 *
 * The id is the hostname of `NEXTAUTH_URL` and the origin is its origin. A
 * missing or unparseable URL throws. Nothing here names a club's host.
 */

export type WebAuthnRelyingParty = {
  rpID: string;
  origin: string;
};

export function webAuthnRelyingParty(
  authUrl: string | undefined = process.env.NEXTAUTH_URL,
): WebAuthnRelyingParty {
  if (typeof authUrl !== "string" || authUrl.trim() === "") {
    throw new Error("NEXTAUTH_URL is required for passkeys");
  }
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    throw new Error("NEXTAUTH_URL is not a URL passkeys can use");
  }
  if (url.hostname === "") {
    throw new Error("NEXTAUTH_URL is not a URL passkeys can use");
  }
  return { rpID: url.hostname, origin: url.origin };
}
