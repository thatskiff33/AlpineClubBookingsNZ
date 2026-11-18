/**
 * The Xero-state and cancellation-settlement labels and chip tones the payments
 * table and its row detail show. Pure lookups with no state, kept beside the
 * page so the page shell stays under its size ceiling.
 */
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  MinusCircle,
  Receipt,
  Wallet,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { type ChipTone } from "@/lib/chip-tones";

export function xeroStateLabel(state: string) {
  switch (state) {
    case "invoiceLinked":
      return "Invoice linked";
    case "invoiceMissing":
      return "Invoice missing";
    case "operationFailed":
      return "Failed activity";
    case "operationPartial":
      return "Partial activity";
    case "operationPending":
      return "Pending activity";
    default:
      return "No invoice needed";
  }
}

// Xero states have no StatusChip `kind`, so they render through the shared
// MiniChip family: a tone + icon carrying the same meaning the old colour-only
// badges did. Restores the distinct hues the five-tone collapse flattened (#156):
// linked = success (green), invoiceMissing = orange (its own accent hue, as the
// old `xeroStateClass` used), partial/pending = warning (amber, distinguished by
// icon), failed = danger (red), not-needed = neutral. Labels are unchanged.
export function xeroStateChip(state: string): { tone: ChipTone; icon: LucideIcon } {
  switch (state) {
    case "invoiceLinked":
      return { tone: "success", icon: CheckCircle2 };
    case "invoiceMissing":
      return { tone: "cat4", icon: FileText };
    case "operationFailed":
      return { tone: "danger", icon: XCircle };
    case "operationPartial":
      return { tone: "warning", icon: AlertTriangle };
    case "operationPending":
      return { tone: "warning", icon: Clock };
    default:
      return { tone: "neutral", icon: MinusCircle };
  }
}

// Each cancellation-settlement kind gets a distinct hue (#156): the Settlement
// column previously rendered every kind on the same neutral tone, hiding what
// kind of settlement happened. Icon + label still carry the meaning.
export function settlementKindChip(kind: string): { tone: ChipTone; icon: LucideIcon } {
  switch (kind) {
    case "cardRefund":
      return { tone: "info", icon: CreditCard };
    case "accountCredit":
      return { tone: "cat3", icon: Wallet };
    case "mixed":
      // Pulled out of the blue-purple arc (#156): info/indigo/purple crowded
      // three kinds into pale blue, and cardRefund vs mixed co-occur. cat4 orange sits
      // well clear of the other four kinds (info blue / cat3 / cat6 teal).
      return { tone: "cat4", icon: Receipt };
    case "restoredCredit":
      return { tone: "cat6", icon: Wallet };
    case "none":
    default:
      return { tone: "neutral", icon: MinusCircle };
  }
}

export function settlementKindLabel(kind: string) {
  switch (kind) {
    case "cardRefund":
      return "Card refund";
    case "accountCredit":
      return "Account credit";
    case "mixed":
      return "Mixed";
    case "restoredCredit":
      return "Restored credit";
    case "none":
    default:
      return "None";
  }
}
