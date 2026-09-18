import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

import {
  MIRO_JWT_KEY_MIN_LENGTH,
  buildMirotalkToken,
  cryptoJsAesEncrypt,
  describeMirotalkJwtKeyWeakness,
  mintMirotalkAccessToken,
  signHs256,
} from "@/lib/mirotalk-token";

// ---------------------------------------------------------------------------
// Known-answer vectors (KAT) captured from the GENUINE libraries that MiroTalk
// actually uses — crypto-js@4 (AES/OpenSSL "Salted__" format, MD5 EvpKDF) and
// jsonwebtoken@9 (HS256). Neither library is a dependency of this app (we
// re-implement both with Node's built-in `crypto`), so these fixed vectors are
// how the suite proves byte-for-byte compatibility rather than merely
// round-tripping against our own re-implementation. Regenerate with:
//   npm i crypto-js@4 jsonwebtoken@9   (in a scratch dir)
//   const CryptoJS = require("crypto-js");
//   const s = CryptoJS.enc.Hex.parse(KAT_SALT_HEX);
//   const r = CryptoJS.lib.WordArray.random; CryptoJS.lib.WordArray.random = () => s.clone();
//   CryptoJS.AES.encrypt(KAT_PLAINTEXT, KAT_KEY).toString();      // → KAT_AES_B64
//   CryptoJS.lib.WordArray.random = r;
//   Date.now = () => KAT_IAT * 1000;
//   require("jsonwebtoken").sign({ data: KAT_AES_B64 }, KAT_KEY,  // → KAT_JWT
//     { algorithm: "HS256", expiresIn: 3600 });
const KAT_KEY = "shared-jwt-key";
const KAT_PLAINTEXT = JSON.stringify({
  username: "lwtc",
  password: "pw",
  presenter: "true",
});
const KAT_SALT_HEX = "0001020304050607";
const KAT_AES_B64 =
  "U2FsdGVkX18AAQIDBAUGB8wfIax4rSig77kqVEX/mtxFSGNnS+shwN9Sloo7oixLZY2oq2X/b+IJ02hRg5MeLboOS/zH8BkiSPPONBbONLo=";
const KAT_IAT = 1_700_000_000;
const KAT_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXRhIjoiVTJGc2RHVmtYMThBQVFJREJBVUdCOHdmSWF4NHJTaWc3N2txVkVYL210eEZTR05uUytzaHdOOVNsb283b2l4TFpZMm9xMlgvYitJSjAyaFJnNU1lTGJvT1Mvekg4QmtpU1BQT05CYk9OTG89IiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDM2MDB9.Tpa8rwDsiXuKPVud59TmKAkW_jTuSlIUYiW-d7w06aQ";

describe("MiroTalk crypto known-answer vectors (genuine libraries)", () => {
  it("cryptoJsAesEncrypt reproduces genuine crypto-js output byte-for-byte (fixed salt)", () => {
    // The whole point of the pinned-salt overload: with the same salt the output
    // must EQUAL what crypto-js@4's AES.encrypt(plaintext, passphrase) produced.
    const out = cryptoJsAesEncrypt(
      KAT_PLAINTEXT,
      KAT_KEY,
      Buffer.from(KAT_SALT_HEX, "hex"),
    );
    expect(out).toBe(KAT_AES_B64);
  });

  it("signHs256 reproduces a genuine jsonwebtoken@9 HS256 token byte-for-byte (fixed clock)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(KAT_IAT * 1000);
    try {
      const token = signHs256({ data: KAT_AES_B64 }, KAT_KEY, 3600);
      expect(token).toBe(KAT_JWT);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Independent OpenSSL/CryptoJS-compatible AES decrypt, so a round-trip proves
// our encrypt produces exactly what MiroTalk's CryptoJS.AES.decrypt consumes.
function cryptoJsAesDecrypt(b64: string, passphrase: string): string {
  const buf = Buffer.from(b64, "base64");
  // Layout: "Salted__"(8) + salt(8) + ciphertext
  const salt = buf.subarray(8, 16);
  const ciphertext = buf.subarray(16);
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  const pass = Buffer.from(passphrase, "utf8");
  while (derived.length < 48) {
    block = crypto
      .createHash("md5")
      .update(Buffer.concat([block, pass, salt]))
      .digest();
    derived = Buffer.concat([derived, block]);
  }
  const key = derived.subarray(0, 32);
  const iv = derived.subarray(32, 48);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

describe("cryptoJsAesEncrypt", () => {
  it("round-trips through the OpenSSL/CryptoJS format", () => {
    const key = "super-secret-key";
    const plaintext = '{"username":"lwtc","presenter":"true"}';
    const encrypted = cryptoJsAesEncrypt(plaintext, key);
    // Always starts with base64("Salted__") — the CryptoJS/OpenSSL header.
    expect(encrypted.startsWith("U2FsdGVk")).toBe(true);
    expect(cryptoJsAesDecrypt(encrypted, key)).toBe(plaintext);
  });

  it("uses a random salt (distinct ciphertext each call)", () => {
    const a = cryptoJsAesEncrypt("x", "k");
    const b = cryptoJsAesEncrypt("x", "k");
    expect(a).not.toBe(b);
  });
});

describe("buildMirotalkToken", () => {
  const key = "shared-jwt-key";

  it("produces a MiroTalk-compatible HS256 JWT whose data decrypts to the payload", () => {
    const token = buildMirotalkToken({
      key,
      username: "lwtc",
      password: "pw",
      presenter: true,
      expiresInSeconds: 3600,
    });

    const [header, payload, signature] = token.split(".");
    expect(header && payload && signature).toBeTruthy();

    // Header is HS256.
    expect(decodeSegment(header)).toEqual({ alg: "HS256", typ: "JWT" });

    // Signature verifies with the shared key (what MiroTalk's jwt.verify does).
    const expectedSig = crypto
      .createHmac("sha256", key)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expectedSig);

    // Payload carries iat/exp and the AES-encrypted credentials in `data`.
    const decodedPayload = decodeSegment(payload) as {
      data: string;
      iat: number;
      exp: number;
    };
    expect(decodedPayload.exp - decodedPayload.iat).toBe(3600);

    // MiroTalk decrypts `data` and reads username/password/presenter (strings).
    const inner = JSON.parse(cryptoJsAesDecrypt(decodedPayload.data, key));
    expect(inner).toEqual({
      username: "lwtc",
      password: "pw",
      presenter: "true",
    });
  });
});

describe("describeMirotalkJwtKeyWeakness", () => {
  it("accepts a generated secret", () => {
    // The shape `openssl rand -base64 32` produces.
    expect(
      describeMirotalkJwtKeyWeakness("Qk9zZ1hUb2tvcm9hMjAyNlNraUNsdWJYWQ=="),
    ).toBeNull();
    // Fixed values, not randomBytes: a random key is *almost* always accepted,
    // and "almost" is how a suite becomes intermittent.
    expect(
      describeMirotalkJwtKeyWeakness("Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2"),
    ).toBeNull();
  });

  it("rejects a key that names MiroTalk or announces itself as a placeholder", () => {
    // MiroTalk ships JWT_KEY pre-filled, and "must equal MiroTalk's JWT_KEY" is
    // exactly the instruction that leads an operator to copy it into both sides.
    for (const key of [
      "mirotalkp2p_jwt_secret",
      "mirotalksfu_jwt_secret",
      "MiroTalk-Super-Long-But-Public-Default-Key-Value",
      "your_jwt_key_here_padded_out_to_thirty_two",
      "changeme-changeme-changeme-changeme",
      "example-key-example-key-example-key",
    ]) {
      expect(describeMirotalkJwtKeyWeakness(key), key).toBe(
        "looks like a shipped example value rather than a generated secret",
      );
    }
  });

  it("rejects a key shorter than the documented minimum, and says how short", () => {
    expect(describeMirotalkJwtKeyWeakness("k")).toBe(
      `is only 1 character long (at least ${MIRO_JWT_KEY_MIN_LENGTH} are needed)`,
    );
    expect(describeMirotalkJwtKeyWeakness("abcdefghijklmnop")).toBe(
      `is only 16 characters long (at least ${MIRO_JWT_KEY_MIN_LENGTH} are needed)`,
    );
    // One character short is still short — the boundary is inclusive.
    expect(
      describeMirotalkJwtKeyWeakness("a".repeat(MIRO_JWT_KEY_MIN_LENGTH - 1)),
    ).toContain("are needed");
    // Exactly at the minimum is accepted.
    const atMinimum = "Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu";
    expect(atMinimum).toHaveLength(MIRO_JWT_KEY_MIN_LENGTH);
    expect(describeMirotalkJwtKeyWeakness(atMinimum)).toBeNull();
  });

  it("rejects a long key made of a handful of repeated characters", () => {
    expect(describeMirotalkJwtKeyWeakness("ab".repeat(40))).toBe(
      "repeats too few distinct characters to carry real entropy",
    );
  });
});

describe("mintMirotalkAccessToken", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Every key used below is deliberately weak, so the advisory warning fires;
    // capture it rather than printing it through the suite.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function mint(key: string, presenter = true) {
    return mintMirotalkAccessToken({
      key,
      username: "lwtc",
      password: "pw",
      presenter,
      expiresInSeconds: 3600,
    });
  }

  it("mints a token that decrypts to the host identity it was handed", () => {
    const token = mint("k");
    const payload = decodeSegment(token.split(".")[1]) as { data: string };
    expect(JSON.parse(cryptoJsAesDecrypt(payload.data, "k"))).toEqual({
      username: "lwtc",
      password: "pw",
      presenter: "true",
    });
  });

  it("carries presenter=false through when the club turned it off", () => {
    const token = mint("k", false);
    const payload = decodeSegment(token.split(".")[1]) as { data: string };
    expect(JSON.parse(cryptoJsAesDecrypt(payload.data, "k")).presenter).toBe(
      "false",
    );
  });

  // The warning is advisory by design: a club whose meeting links stop working
  // is worse off than one running a guessable key, and nothing inside this
  // process can repair the configuration.
  it("warns about a weak key but still mints a working token", () => {
    const token = mint("weak-key-unique-to-this-test");

    expect(token).toBeTruthy();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    // The key may now come from the encrypted store as well as from the
    // environment, so the message names the SETTING rather than a variable.
    expect(message).toContain("meeting signing key");
    expect(message).toContain("openssl rand -base64 32");
    // Never log the secret itself.
    expect(message).not.toContain("weak-key-unique-to-this-test");
    // And the token really is the MiroTalk-compatible one.
    const payload = decodeSegment(token.split(".")[1]) as { data: string };
    expect(
      JSON.parse(
        cryptoJsAesDecrypt(payload.data, "weak-key-unique-to-this-test"),
      ).username,
    ).toBe("lwtc");
  });

  it("warns only once for the same weak key, however many links are served", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(mint("dedupe-short-key")).toBeTruthy();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a properly generated key", () => {
    expect(mint("Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2")).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
