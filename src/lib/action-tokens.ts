import { createHash, randomBytes } from "crypto";

export type IssuedActionToken = {
  token: string;
  tokenHash: string;
};

export function hashActionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function issueActionToken(): IssuedActionToken {
  const token = randomBytes(32).toString("hex");

  return {
    token,
    tokenHash: hashActionToken(token),
  };
}
