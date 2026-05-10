# Hashed Token Migration

Issue `#175` moved password reset, email verification/change, and guest chore
bearer tokens to hash-at-rest storage. Issue `#290` extends the same storage
contract to membership nomination tokens.

## Migration approach

1. Enable `pgcrypto` if needed.
2. Add a new `tokenHash` column to each affected table.
3. Backfill `tokenHash` from the existing plaintext `token` value with `encode(digest(token, 'sha256'), 'hex')`.
4. Enforce `NOT NULL` and recreate unique/index coverage on `tokenHash`.
5. Drop the plaintext `token` column once every row has been backfilled.

## Rollout notes

- Existing links continue working after migration because the raw token value sent to the user hashes to the same stored value.
- No plaintext bearer tokens remain in the database after the migration completes.
- New application code must always store `tokenHash` and compare incoming tokens by hashing the presented value first.
