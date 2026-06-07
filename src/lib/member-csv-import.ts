export const MEMBER_IMPORT_MAX_ROWS = 500;

export interface CsvRecord {
  lineNumber: number;
  values: string[];
}

export interface CsvParseSuccess {
  ok: true;
  records: CsvRecord[];
  blankLineCount: number;
}

export interface CsvParseFailure {
  ok: false;
  error: string;
  lineNumber: number;
}

export type CsvParseResult = CsvParseSuccess | CsvParseFailure;

export interface MemberImportCsvData {
  headers: string[];
  rows: CsvRecord[];
  blankLineCount: number;
}

export type MemberImportCsvParseResult =
  | { ok: true; data: MemberImportCsvData }
  | { ok: false; error: string; lineNumber?: number };

export interface MemberImportRowPayload {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  phoneCountryCode?: string;
  phoneAreaCode?: string;
  phoneNumber?: string;
  dateOfBirth?: string;
  role?: string;
}

export const MEMBER_IMPORT_FIELD_DEFINITIONS = [
  {
    key: "firstName",
    label: "First Name",
    required: true,
    aliases: ["firstname", "first", "givenname"],
  },
  {
    key: "lastName",
    label: "Last Name",
    required: true,
    aliases: ["lastname", "last", "surname", "familyname"],
  },
  {
    key: "email",
    label: "Email",
    required: true,
    aliases: ["email", "emailaddress"],
  },
  {
    key: "phone",
    label: "Phone",
    required: false,
    aliases: ["phone", "telephone", "mobile"],
  },
  {
    key: "phoneCountryCode",
    label: "Phone Country Code",
    required: false,
    aliases: ["phonecountrycode", "countrycode"],
  },
  {
    key: "phoneAreaCode",
    label: "Phone Area Code",
    required: false,
    aliases: ["phoneareacode", "areacode"],
  },
  {
    key: "phoneNumber",
    label: "Phone Number",
    required: false,
    aliases: ["phonenumber", "number", "mobilenumber"],
  },
  {
    key: "dateOfBirth",
    label: "Date of Birth",
    required: false,
    aliases: ["dateofbirth", "dob", "birthdate"],
  },
  {
    key: "role",
    label: "Role",
    required: false,
    aliases: ["role", "memberrole"],
  },
] as const;

export type MemberImportFieldKey =
  (typeof MEMBER_IMPORT_FIELD_DEFINITIONS)[number]["key"];

export type MemberImportColumnMapping = Record<MemberImportFieldKey, number | null>;

export interface MemberImportPreviewRow {
  lineNumber: number;
  sourceValues: string[];
  values: MemberImportRowPayload;
  errors: string[];
}

export interface MemberImportPreview {
  rows: MemberImportPreviewRow[];
  importRows: MemberImportRowPayload[];
  fileErrors: string[];
  hasErrors: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VALID_ROLES = new Set(["MEMBER", "ADMIN"]);

function isLineBreak(character: string) {
  return character === "\n" || character === "\r";
}

function isHorizontalWhitespace(character: string) {
  return character === " " || character === "\t";
}

function nextLineBreakIndex(text: string, index: number) {
  return text[index] === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
}

export function parseCsv(text: string): CsvParseResult {
  const records: CsvRecord[] = [];
  let blankLineCount = 0;
  let row: string[] = [];
  let field = "";
  let fieldQuoted = false;
  let fieldWasStarted = false;
  let recordWasStarted = false;
  let inQuotes = false;
  let afterClosingQuote = false;
  let lineNumber = 1;
  let recordStartLine = 1;
  let quotedFieldStartLine = 1;

  const startRecord = () => {
    if (!recordWasStarted) {
      recordStartLine = lineNumber;
      recordWasStarted = true;
    }
  };

  const pushField = () => {
    row.push(fieldQuoted ? field : field.trim());
    field = "";
    fieldQuoted = false;
    fieldWasStarted = false;
    afterClosingQuote = false;
  };

  const pushRow = (nextRecordStartLine: number) => {
    pushField();
    if (row.some((value) => value.trim() !== "")) {
      records.push({ lineNumber: recordStartLine, values: row });
    } else {
      blankLineCount += 1;
    }
    row = [];
    recordWasStarted = false;
    recordStartLine = nextRecordStartLine;
  };

  let index = 0;
  while (index < text.length) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        afterClosingQuote = true;
        index += 1;
        continue;
      }

      if (isLineBreak(character)) {
        field += "\n";
        index = nextLineBreakIndex(text, index);
        lineNumber += 1;
        continue;
      }

      field += character;
      index += 1;
      continue;
    }

    if (afterClosingQuote) {
      if (character === ",") {
        pushField();
        index += 1;
        continue;
      }

      if (isLineBreak(character)) {
        const nextIndex = nextLineBreakIndex(text, index);
        pushRow(lineNumber + 1);
        index = nextIndex;
        lineNumber += 1;
        continue;
      }

      if (isHorizontalWhitespace(character)) {
        index += 1;
        continue;
      }

      return {
        ok: false,
        error: "Unexpected character after closing quote",
        lineNumber,
      };
    }

    if (character === ",") {
      startRecord();
      pushField();
      index += 1;
      continue;
    }

    if (isLineBreak(character)) {
      const nextIndex = nextLineBreakIndex(text, index);
      pushRow(lineNumber + 1);
      index = nextIndex;
      lineNumber += 1;
      continue;
    }

    if (character === '"') {
      if (field.trim().length > 0) {
        return {
          ok: false,
          error: "Unexpected quote in unquoted field",
          lineNumber,
        };
      }
      startRecord();
      field = "";
      fieldQuoted = true;
      fieldWasStarted = true;
      inQuotes = true;
      quotedFieldStartLine = lineNumber;
      index += 1;
      continue;
    }

    startRecord();
    field += character;
    fieldWasStarted = true;
    index += 1;
  }

  if (inQuotes) {
    return {
      ok: false,
      error: "Unterminated quoted field",
      lineNumber: quotedFieldStartLine,
    };
  }

  if (recordWasStarted || row.length > 0 || fieldWasStarted || field.length > 0 || afterClosingQuote) {
    pushRow(lineNumber + 1);
  }

  return { ok: true, records, blankLineCount };
}

export function parseMemberImportCsv(text: string): MemberImportCsvParseResult {
  const parsed = parseCsv(text);
  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.records.length < 2) {
    return {
      ok: false,
      error: "CSV must have a header row and at least one data row",
    };
  }

  const [headerRecord, ...rows] = parsed.records;
  const headers = headerRecord.values.map((header) => header.trim());
  if (headers.every((header) => header === "")) {
    return { ok: false, error: "CSV header row cannot be blank", lineNumber: headerRecord.lineNumber };
  }

  return {
    ok: true,
    data: {
      headers,
      rows,
      blankLineCount: parsed.blankLineCount,
    },
  };
}

export function normalizeMemberImportHeader(header: string) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function createEmptyMemberImportColumnMapping(): MemberImportColumnMapping {
  return {
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    dateOfBirth: null,
    role: null,
  };
}

export function inferMemberImportColumnMapping(headers: string[]): MemberImportColumnMapping {
  const mapping = createEmptyMemberImportColumnMapping();
  const normalizedHeaders = headers.map(normalizeMemberImportHeader);

  for (const definition of MEMBER_IMPORT_FIELD_DEFINITIONS) {
    const columnIndex = normalizedHeaders.findIndex((header) =>
      (definition.aliases as readonly string[]).includes(header)
    );
    if (columnIndex >= 0) {
      mapping[definition.key] = columnIndex;
    }
  }

  return mapping;
}

export function buildMemberImportPreview(
  csv: MemberImportCsvData,
  mapping: MemberImportColumnMapping
): MemberImportPreview {
  const fileErrors: string[] = [];
  const missingRequiredFields = MEMBER_IMPORT_FIELD_DEFINITIONS
    .filter((definition) => definition.required && mapping[definition.key] === null)
    .map((definition) => definition.label);

  if (missingRequiredFields.length > 0) {
    fileErrors.push(`Map required columns: ${missingRequiredFields.join(", ")}`);
  }

  if (csv.rows.length === 0) {
    fileErrors.push("CSV must include at least one data row");
  }

  if (csv.rows.length > MEMBER_IMPORT_MAX_ROWS) {
    fileErrors.push(`Maximum ${MEMBER_IMPORT_MAX_ROWS} rows per import`);
  }

  const getValue = (record: CsvRecord, key: MemberImportFieldKey) => {
    const columnIndex = mapping[key];
    if (columnIndex === null) return "";
    return record.values[columnIndex]?.trim() ?? "";
  };

  const rows: MemberImportPreviewRow[] = csv.rows.map((record) => {
    const role = getValue(record, "role").toUpperCase();
    const values: MemberImportRowPayload = {
      firstName: getValue(record, "firstName"),
      lastName: getValue(record, "lastName"),
      email: getValue(record, "email"),
    };
    const phone = getValue(record, "phone");
    const phoneCountryCode = getValue(record, "phoneCountryCode");
    const phoneAreaCode = getValue(record, "phoneAreaCode");
    const phoneNumber = getValue(record, "phoneNumber");
    const dateOfBirth = getValue(record, "dateOfBirth");

    if (phone) values.phone = phone;
    if (phoneCountryCode) values.phoneCountryCode = phoneCountryCode;
    if (phoneAreaCode) values.phoneAreaCode = phoneAreaCode;
    if (phoneNumber) values.phoneNumber = phoneNumber;
    if (dateOfBirth) values.dateOfBirth = dateOfBirth;
    values.role = role || "MEMBER";

    const errors: string[] = [];
    if (!values.firstName) errors.push("First name is required");
    if (!values.lastName) errors.push("Last name is required");
    if (!values.email) {
      errors.push("Email is required");
    } else if (!EMAIL_PATTERN.test(values.email)) {
      errors.push("Invalid email address");
    }
    if (dateOfBirth && !DATE_ONLY_PATTERN.test(dateOfBirth)) {
      errors.push("Date of birth must be YYYY-MM-DD");
    }
    if (role && !VALID_ROLES.has(role)) {
      errors.push("Role must be MEMBER or ADMIN");
    }

    return {
      lineNumber: record.lineNumber,
      sourceValues: record.values,
      values,
      errors,
    };
  });

  const seenEmails = new Map<string, number>();
  for (const row of rows) {
    const email = row.values.email.toLowerCase().trim();
    if (!email || !EMAIL_PATTERN.test(email)) continue;

    const firstLine = seenEmails.get(email);
    if (firstLine) {
      row.errors.push(`Duplicate email in file (same as line ${firstLine})`);
    } else {
      seenEmails.set(email, row.lineNumber);
    }
  }

  return {
    rows,
    importRows: rows.map((row) => row.values),
    fileErrors,
    hasErrors: fileErrors.length > 0 || rows.some((row) => row.errors.length > 0),
  };
}
