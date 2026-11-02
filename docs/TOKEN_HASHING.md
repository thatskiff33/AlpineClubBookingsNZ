# Token Hashing

Password reset, email verification/change, guest chore, and membership
nomination bearer tokens use hash-at-rest storage.

## Hash-at-rest design

1. Enable `pgcrypto` if needed.
2. Add a new `tokenHash` column to each affected table.
3. Backfill `tokenHash` from the existing plaintext `token` value with `encode(digest(token, 'sha256'), 'hex')`.
4. Enforce `NOT NULL` and recreate unique/index coverage on `tokenHash`.
5. Drop the plaintext `token` column once every row has been backfilled.

## Rollout notes

- Existing links continue working after migration because the raw token value sent to the user hashes to the same stored value.
- No plaintext bearer tokens remain in the database after the migration completes.
- New application code must always store `tokenHash` and compare incoming tokens by hashing the presented value first.

## Keyed code hashes and the data-encryption key ring (#4456)

Two-factor recovery codes, emailed two-factor codes and the single-use
session-challenge token are not plain SHA-256: they are HMAC-SHA256 under a
secret key, because a six-digit code has too little entropy to survive an
unkeyed hash. The key comes from the data-encryption key ring
(`src/lib/data-encryption-keys.ts`; the variable is described in
[`CONFIGURATION.md`](../CONFIGURATION.md#data-encryption-keys-4456)):

- **No ring set:** the hash is HMAC-SHA256 under a key derived from the auth
  secret, stored as bare hex — exactly the format before #4456.
- **Ring set:** a new code is stored as `<key id>:<hex>`, the HMAC under a
  sub-key of the ring's current key. A lookup computes the presented code's hash
  under every ring key and asks for `codeHash IN (…)`, so codes issued under an
  older ring key keep working until that key leaves the ring.
- **The auth-secret hash is never a lookup candidate once a ring is set.** A
  hash cannot be re-keyed, so recovery codes issued under the auth secret stop
  working at cut-over (owner decision on #4456), and `memberHoldsRetiredRecoveryCodes`
  drives the notice telling the member to generate a new set. Emailed codes
  last ten minutes and session challenges two, so theirs simply expire.

The bearer tokens in the first section (password reset, email verification,
chore and nomination links) carry enough entropy for an unkeyed SHA-256 and do
not use the ring.
