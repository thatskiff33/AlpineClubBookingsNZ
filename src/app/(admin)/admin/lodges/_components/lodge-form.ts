// The Admin → Lodges add/edit form's state and payload (#2925, #3407, fork #123),
// kept beside the page so the page stays a shell.
import { LODGE_INVOICE_DETAIL_FIELDS } from "@/lib/lodges";
import {
  NZ_BANK_ACCOUNT_INVALID_MESSAGE,
  nzBankAccountNumberForSave,
} from "@/lib/nz-bank-account";

/**
 * The lodge DETAIL fields, which `GET /api/admin/lodges` omits for a caller
 * holding no `lodge:view` (#2925): the three the create form also takes, then
 * the invoice details (fork #115), which only the edit form shows (fork #123) because
 * `POST /api/admin/lodges` does not accept them.
 */
const CREATE_DETAIL_FIELDS = ["address", "doorCode", "travelNote"] as const;
const LODGE_DETAIL_FIELDS = [...CREATE_DETAIL_FIELDS, ...LODGE_INVOICE_DETAIL_FIELDS] as const;
export type LodgeDetailField = (typeof LODGE_DETAIL_FIELDS)[number];

export type LodgeRecord = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
} & Partial<Record<LodgeDetailField, string | null>>; // absent when narrowed (#2925)

export type LodgeFormState = {
  name: string;
} & Record<LodgeDetailField, string> & {
  /** Maximum guests, as typed. Sent on create only (#3407). */
  capacity: string;
  /**
   * Which detail fields the record this form was seeded from actually carried
   * (#2925). A field missing here is OMITTED from the PATCH body rather than
   * sent as an empty string, because the PATCH route treats an absent key as
   * "leave unchanged" and a `null` as "clear it" — so seeding a form from a
   * narrowed record and saving it would otherwise WIPE the door code.
   *
   * BELT-AND-BRACES, and worth knowing which: the wipe is already impossible at
   * the server. The PATCH needs `lodge:edit`, the list narrows below
   * `lodge:view`, and `edit` outranks `view` in `LEVEL_RANK` — so any caller who
   * can write here was served the full record. This is kept because it is a few
   * lines and directly tested; it is deliberately not replicated in the lodge
   * setup wizard, where a second copy bought no reachable safety and made the
   * page reject any lodge fixture that omitted `doorCode`.
   */
  detailFields: readonly LodgeDetailField[];
};

export const emptyForm: LodgeFormState = {
  name: "",
  ...(Object.fromEntries(LODGE_DETAIL_FIELDS.map((field) => [field, ""])) as Record<
    LodgeDetailField,
    string
  >),
  capacity: "",
  // A create starts from a blank form the admin filled in themselves, so the
  // three create fields are theirs to send.
  detailFields: CREATE_DETAIL_FIELDS,
};

export function formFromLodge(lodge: LodgeRecord): LodgeFormState {
  return {
    name: lodge.name,
    ...(Object.fromEntries(
      LODGE_DETAIL_FIELDS.map((field) => [field, lodge[field] ?? ""]),
    ) as Record<LodgeDetailField, string>),
    capacity: "",
    detailFields: LODGE_DETAIL_FIELDS.filter((field) => field in lodge),
  };
}

export function formPayload(form: LodgeFormState) {
  const payload: { name: string } & Partial<Record<LodgeDetailField, string | null>> = {
    name: form.name.trim(),
  };
  for (const field of form.detailFields) {
    payload[field] = form[field].trim() || null;
  }
  // The bank account goes as its hyphenated NZ number; `lodgeFormBankAccountError` has
  // refused an incomplete one already.
  if (form.detailFields.includes("bankAccountDetails")) {
    const bankAccount = nzBankAccountNumberForSave(form.bankAccountDetails);
    payload.bankAccountDetails = bankAccount.kind === "VALID" ? bankAccount.value : null;
  }
  return payload;
}

/** Why the form cannot be saved yet, or `null`: the bank account number, when this form sends it, must be complete. */
export function lodgeFormBankAccountError(form: LodgeFormState): string | null {
  return form.detailFields.includes("bankAccountDetails") &&
    nzBankAccountNumberForSave(form.bankAccountDetails).kind === "INVALID"
    ? NZ_BANK_ACCOUNT_INVALID_MESSAGE
    : null;
}
