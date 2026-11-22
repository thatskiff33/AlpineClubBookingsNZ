/**
 * What each Finance officer action in `catalogue/finance-xero-contacts.ts` returns
 * (ALP-721, `INV-MCP-006`): the one place a catalogue entry's `returns`
 * and its route's projection both read (`INV-SSOT`). Money is integer cents.
 *
 * An officer's connection sends what it reads to the officer's AI provider,
 * so each shape keeps what the officer needs and leaves out contact details,
 * tokens, raw provider payloads and free text the answer does not need.
 * Types only: nothing here reaches the database.
 */
import { connectionShapeFor } from "@/lib/connection-projection";
