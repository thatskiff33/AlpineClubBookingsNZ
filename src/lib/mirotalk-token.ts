import "server-only";
import crypto from "node:crypto";

/**
 * MiroTalk P2P JWT access tokens (#calendar meetings).
 *
 * Reproduces MiroTalk P2P's own `encodeToken` byte-for-byte so a token we sign
 * is accepted by a MiroTalk instance sharing the same `JWT_KEY`. From MiroTalk's
 * `app/src/server.js`:
 *
 *   payload   = { username, password, presenter }   // all String()-ified
 *   encrypted = CryptoJS.AES.encrypt(JSON.stringify(payload), JWT_KEY)
 *   token     = jwt.sign({ data: encrypted }, JWT_KEY, { expiresIn })
 *
 * On join MiroTalk verifies the JWT signature, AES-decrypts `data`, then calls
 * `isAuthPeer(username, password)` — so the embedded credentials MUST match a
 * `HOST_USERS` entry. `presenter === 'true'` (or being first into the room)
 * makes the peer a host.
 *
 * This module is server-only: the signing key and the host password are secrets
 * and must never reach the browser. The join URL is assembled during server-side
 * API serialization (see buildMeetingJoinUrl), so a fresh, short-lived token is
 * minted each time the calendar is served.
 *
 * Implemented with Node's built-in `crypto` (no new dependencies). The AES step
 * matches CryptoJS's OpenSSL-compatible format exactly: an 8-byte random salt,
 * EVP_BytesToKey (MD5) key/IV derivation, AES-256-CBC, output
 * `base64("Salted__" + salt + ciphertext)`.
 */

/**
 * OpenSSL EVP_BytesToKey with MD5 (one hash chain), as CryptoJS uses.
 *
 * MD5 HERE IS FIXED BY THE PROTOCOL AND MUST NOT BE "UPGRADED". CodeQL flags
 * this line as `js/insufficient-password-hash` (alert 27, #2841). It is not
 * hashing a password for storage or comparison: it is OpenSSL's
 * EVP_BytesToKey, reproduced byte-for-byte so that the AES blob we produce is
 * exactly what MiroTalk's `CryptoJS.AES.decrypt` consumes. Swap the digest and
 * every token this app mints stops decrypting on the MiroTalk side — the
 * known-answer vectors at the top of mirotalk-token.test.ts exist to catch
 * precisely that.
 *
 * What actually protects the credentials inside the token is the ENTROPY of
 * MIRO_JWT_KEY, which is also the HS256 signing key — so that is where the
 * hardening went (`describeMirotalkJwtKeyWeakness` below). The full triage is
 * recorded once in docs/SECURITY-ATTACK-SURFACE.md -> "MiroTalk meeting
 * tokens".
 */
function evpBytesToKey(
  passphrase: Buffer,
  salt: Buffer,
  keyLen: number,
  ivLen: number,
): { key: Buffer; iv: Buffer } {
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    block = crypto
      .createHash("md5")
      .update(Buffer.concat([block, passphrase, salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  return {
    key: derived.subarray(0, keyLen),
    iv: derived.subarray(keyLen, keyLen + ivLen),
  };
}

/**
 * CryptoJS-compatible `AES.encrypt(message, passphrase)`. `salt` is exposed only
 * so tests can pin a known-answer vector; production always uses a random salt.
 */
export function cryptoJsAesEncrypt(
  plaintext: string,
  passphrase: string,
  salt: Buffer = crypto.randomBytes(8),
): string {
  const { key, iv } = evpBytesToKey(
    Buffer.from(passphrase, "utf8"),
    salt,
    32,
    16,
  );
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from("Salted__", "utf8"),
    salt,
    ciphertext,
  ]).toString("base64");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Minimal HS256 JWT (`jsonwebtoken`-compatible for verify + exp). Exported so a
 * known-answer test can pin it against a token minted by the genuine
 * `jsonwebtoken` library (see mirotalk-token.test.ts).
 */
export function signHs256(
  data: Record<string, unknown>,
  key: string,
  expiresInSeconds: number,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...data, iat: nowSeconds, exp: nowSeconds + expiresInSeconds };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = base64url(
    crypto.createHmac("sha256", key).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

/**
 * Parse a MiroTalk-style expiry (`"1h"`, `"30m"`, `"45s"`, `"1d"`, or a bare
 * number of seconds) into seconds. Falls back to one hour.
 */
export function parseExpiresToSeconds(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return 3600;
  const match = /^(\d+)\s*([smhd]?)$/i.exec(raw);
  if (!match) return 3600;
  // Both capture groups are what the pattern is for; without them there is no
  // duration to read and the documented one-hour default stands (#2800).
  const amountText = match[1];
  const unit = match[2];
  if (amountText === undefined || unit === undefined) return 3600;
  const amount = Number(amountText);
  switch (unit.toLowerCase()) {
    case "s":
    case "":
      return amount;
    case "m":
      return amount * 60;
    case "h":
      return amount * 3600;
    case "d":
      return amount * 86400;
    default:
      return 3600;
  }
}

/**
 * Shortest MIRO_JWT_KEY that does not draw a warning. 32 characters is what
 * `openssl rand -base64 32` produces (44 characters) comfortably clears, and it
 * is the length the documentation now asks for.
 */
export const MIRO_JWT_KEY_MIN_LENGTH = 32;

/**
 * Fragments that mark a key as a copied example rather than a generated secret.
 * MiroTalk ships its `JWT_KEY` pre-filled in `.env.template`, and an operator
 * following its quick-start keeps that value on both sides — at which point the
 * key protecting our host credentials is public knowledge.
 *
 * These match the SHAPE of a shipped placeholder (any value naming MiroTalk or
 * announcing itself as a secret/placeholder) rather than pinning MiroTalk's
 * exact literal, which is not vendored here and was not verified against
 * upstream from this offline checkout.
 */
const PLACEHOLDER_KEY_FRAGMENTS = [
  "mirotalk",
  "jwt_secret",
  "jwt-secret",
  "changeme",
  "change-me",
  "change_me",
  "your_",
  "your-",
  "example",
  "placeholder",
  "password",
  "secret123",
];

/**
 * Plain-English reason MIRO_JWT_KEY is too weak to be trusted, or null when it
 * looks like a generated secret.
 *
 * Why this exists (#2841, alongside CodeQL alert 27): the key is BOTH the AES
 * passphrase for the credentials embedded in a join token AND the HS256 signing
 * key for that token. Anyone who guesses it can mint a token that MiroTalk
 * accepts as a host. Until now it carried no documented entropy requirement at
 * all — `.env.example` and the calendar guide said only that it must equal
 * MiroTalk's own `JWT_KEY`, which is exactly the instruction that leads an
 * operator to copy MiroTalk's shipped placeholder into both.
 *
 * Deliberately advisory: a weak key still mints working tokens, because a
 * meeting link that silently stops working is a worse failure for a club than a
 * guessable one, and the deployment cannot be repaired from inside this
 * process.
 */
export function describeMirotalkJwtKeyWeakness(key: string): string | null {
  const lower = key.toLowerCase();
  if (PLACEHOLDER_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    return "looks like a shipped example value rather than a generated secret";
  }
  if (key.length < MIRO_JWT_KEY_MIN_LENGTH) {
    return `is only ${key.length} character${key.length === 1 ? "" : "s"} long (at least ${MIRO_JWT_KEY_MIN_LENGTH} are needed)`;
  }
  if (new Set(key).size < 8) {
    return "repeats too few distinct characters to carry real entropy";
  }
  return null;
}

// Keys already warned about, so a per-request mint does not fill the logs. The
// key itself is never stored or logged — only a digest, and only in memory.
const warnedKeyDigests = new Set<string>();

function warnOnceAboutWeakKey(key: string): void {
  const weakness = describeMirotalkJwtKeyWeakness(key);
  if (!weakness) return;
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  if (warnedKeyDigests.has(digest)) return;
  warnedKeyDigests.add(digest);
  console.warn(
    `mirotalk: MIRO_JWT_KEY ${weakness}. That key both signs every meeting join token and encrypts the host credentials inside it, so a guessable value lets anyone mint a token MiroTalk accepts as host. Generate one with "openssl rand -base64 32" and set the same value as MiroTalk's JWT_KEY. Meeting links keep working — this is a warning, not a failure.`,
  );
}

export interface MirotalkTokenInput {
  key: string;
  username: string;
  password: string;
  presenter: boolean;
  expiresInSeconds: number;
}

/** Sign a MiroTalk P2P access token (see module doc for the exact format). */
export function buildMirotalkToken(input: MirotalkTokenInput): string {
  const payload = {
    username: String(input.username),
    password: String(input.password),
    presenter: String(input.presenter),
  };
  const encrypted = cryptoJsAesEncrypt(JSON.stringify(payload), input.key);
  return signHs256({ data: encrypted }, input.key, input.expiresInSeconds);
}

/**
 * Build the meeting token from the app environment, or null when JWT access is
 * not configured (then the join link carries no token and MiroTalk falls back to
 * its own host-login prompt). A key that fails
 * `describeMirotalkJwtKeyWeakness` logs one warning per distinct key and is
 * then used anyway. Requires all three of `MIRO_JWT_KEY`,
 * `MIRO_MEETING_USERNAME`, and `MIRO_MEETING_PASSWORD` — with HOST_USER_AUTH on,
 * a token whose credentials do not match a HOST_USERS entry would be rejected,
 * so we omit the token entirely rather than emit one that cannot authenticate.
 */
export function resolveMirotalkMeetingToken(): string | null {
  const key = process.env.MIRO_JWT_KEY?.trim();
  const username = process.env.MIRO_MEETING_USERNAME?.trim();
  const password = process.env.MIRO_MEETING_PASSWORD;
  if (!key || !username || !password) return null;

  // Advisory only — the token is still minted below (#2841).
  warnOnceAboutWeakKey(key);

  // Default true: the calendar link is meant to let committee members open and
  // host the meeting immediately. MiroTalk's /join page grants host status
  // purely from this flag (it does NOT apply first-to-join there), so "false"
  // leaves the clicker stuck on the "waiting for host" screen. Set
  // MIRO_MEETING_PRESENTER=false only if you want joiners to wait for a host.
  const presenter =
    (process.env.MIRO_MEETING_PRESENTER ?? "true").trim().toLowerCase() !==
    "false";
  const expiresInSeconds = parseExpiresToSeconds(process.env.MIRO_JWT_EXP);

  return buildMirotalkToken({
    key,
    username,
    password,
    presenter,
    expiresInSeconds,
  });
}
