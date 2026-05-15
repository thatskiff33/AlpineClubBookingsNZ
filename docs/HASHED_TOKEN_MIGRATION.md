# Hashed Token Migration

Password reset, email verification/change, guest chore, and membership
nomination bearer tokens use hash-at-rest storage.

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
