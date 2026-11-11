/** Shared raw transaction-lock spelling for inventories and isolation checks. */
export const ADVISORY_LOCK_CALL = /pg_(?:try_)?advisory_xact_lock\s*\(/g;
