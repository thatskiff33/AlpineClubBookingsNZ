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
  fullName?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  phoneCountryCode?: string;
  phoneAreaCode?: string;
  phoneNumber?: string;
  dateOfBirth?: string;
  joinedDate?: string;
  role?: string;
  sourceLineNumber?: number;
  sourceColumnLabels?: Record<string, string>;
}

export const MEMBER_IMPORT_FIELD_DEFINITIONS = [
  {
    key: "fullName",
    label: "Full Name",
    required: false,
    aliases: ["name", "fullname", "membername"],
  },
  {
    key: "firstName",
    label: "First Name",
    required: true,
    aliases: ["firstname", "first", "givenname", "given"],
  },
  {
    key: "lastName",
    label: "Last Name",
    required: true,
    aliases: ["lastname", "last", "surname", "familyname", "family"],
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
    aliases: ["dateofbirth", "dob", "birthdate", "birth"],
  },
  {
    key: "joinedDate",
    label: "Joined Date",
    required: false,
    aliases: ["joineddate", "joindate", "joined", "membershipstartdate", "membershipstart", "startdate"],
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

export const MEMBER_IMPORT_DATE_FIELD_KEYS = ["dateOfBirth", "joinedDate"] as const;
export type MemberImportDateFieldKey = (typeof MEMBER_IMPORT_DATE_FIELD_KEYS)[number];

export const MEMBER_IMPORT_DATE_FORMATS = [
  { value: "yyyy-MM-dd", label: "yyyy-MM-dd", example: "1990-01-15" },
  { value: "dd/MM/yyyy", label: "dd/MM/yyyy", example: "15/01/1990" },
  { value: "d/M/yyyy", label: "d/M/yyyy", example: "5/1/1990" },
  { value: "MM/dd/yyyy", label: "MM/dd/yyyy", example: "01/15/1990" },
  { value: "dd-MM-yyyy", label: "dd-MM-yyyy", example: "15-01-1990" },
  { value: "d MMM yyyy", label: "d MMM yyyy", example: "5 Jan 1990" },
  { value: "MMM d yyyy", label: "MMM d yyyy", example: "Jan 5 1990" },
] as const;

export const MEMBER_IMPORT_DATE_FORMAT_VALUES = MEMBER_IMPORT_DATE_FORMATS.map(
  (format) => format.value
) as [MemberImportDateFormat, ...MemberImportDateFormat[]];

export type MemberImportDateFormat = (typeof MEMBER_IMPORT_DATE_FORMATS)[number]["value"];
export type MemberImportDateFormatMapping = Record<
  MemberImportDateFieldKey,
  MemberImportDateFormat
>;

export const DEFAULT_MEMBER_IMPORT_DATE_FORMAT: MemberImportDateFormat = "yyyy-MM-dd";

export interface MemberImportPreviewRow {
  lineNumber: number;
  sourceValues: string[];
  values: MemberImportRowPayload;
  normalizedDateValues: Partial<Record<MemberImportDateFieldKey, string>>;
  errors: string[];
}

export interface MemberImportPreview {
  rows: MemberImportPreviewRow[];
  importRows: MemberImportRowPayload[];
  fileErrors: string[];
  hasErrors: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["MEMBER", "ADMIN"]);
const MONTHS_BY_ABBREVIATION = new Map([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

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
    fullName: null,
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    dateOfBirth: null,
    joinedDate: null,
    role: null,
  };
}

export function createDefaultMemberImportDateFormatMapping(): MemberImportDateFormatMapping {
  return {
    dateOfBirth: DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
    joinedDate: DEFAULT_MEMBER_IMPORT_DATE_FORMAT,
  };
}

export function isMemberImportDateField(
  fieldKey: MemberImportFieldKey
): fieldKey is MemberImportDateFieldKey {
  return (MEMBER_IMPORT_DATE_FIELD_KEYS as readonly string[]).includes(fieldKey);
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

function cleanMemberImportName(value: string | null | undefined) {
  return (value ?? "").replace(/[\r\n]+/g, " ").trim();
}

export function deriveMemberImportNameFields({
  fullName,
  firstName,
  lastName,
}: {
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  let cleanFirstName = cleanMemberImportName(firstName);
  let cleanLastName = cleanMemberImportName(lastName);
  const cleanFullName = cleanMemberImportName(fullName);

  if (cleanFullName && (!cleanFirstName || !cleanLastName)) {
    const parts = cleanFullName.split(/\s+/).filter(Boolean);
    if (!cleanFirstName) {
      cleanFirstName = parts[0] ?? "";
    }
    if (!cleanLastName) {
      cleanLastName = parts.slice(1).join(" ");
    }
  }

  return {
    fullName: cleanFullName,
    firstName: cleanFirstName,
    lastName: cleanLastName,
  };
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}

function normalizeDateParts(year: number, month: number, day: number) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const normalized = `${String(year).padStart(4, "0")}-${padDatePart(month)}-${padDatePart(day)}`;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    return null;
  }

  return normalized;
}

function parseMonthName(value: string) {
  return MONTHS_BY_ABBREVIATION.get(value.trim().slice(0, 3).toLowerCase()) ?? null;
}

export type MemberImportDateNormalizationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function normalizeMemberImportDateValue(
  value: string,
  format: MemberImportDateFormat = DEFAULT_MEMBER_IMPORT_DATE_FORMAT
): MemberImportDateNormalizationResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: true, value: "" };
  }

  let year: number;
  let month: number | null;
  let day: number;
  let match: RegExpMatchArray | null;

  switch (format) {
    case "yyyy-MM-dd":
      match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return { ok: false, error: `must match ${format}` };
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
      break;
    case "dd/MM/yyyy":
      match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!match) return { ok: false, error: `must match ${format}` };
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
      break;
    case "d/M/yyyy":
      match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) return { ok: false, error: `must match ${format}` };
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
      break;
    case "MM/dd/yyyy":
      match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!match) return { ok: false, error: `must match ${format}` };
      month = Number(match[1]);
      day = Number(match[2]);
      year = Number(match[3]);
      break;
    case "dd-MM-yyyy":
      match = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (!match) return { ok: false, error: `must match ${format}` };
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
      break;
    case "d MMM yyyy":
      match = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
      if (!match) return { ok: false, error: `must match ${format}` };
      day = Number(match[1]);
      month = parseMonthName(match[2]);
      year = Number(match[3]);
      break;
    case "MMM d yyyy":
      match = trimmed.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
      if (!match) return { ok: false, error: `must match ${format}` };
      month = parseMonthName(match[1]);
      day = Number(match[2]);
      year = Number(match[3]);
      break;
    default:
      return { ok: false, error: "uses an unsupported date format" };
  }

  if (month === null) {
    return { ok: false, error: `contains an unknown month for ${format}` };
  }

  const normalized = normalizeDateParts(year, month, day);
  if (!normalized) {
    return { ok: false, error: `is not a valid calendar date for ${format}` };
  }

  return { ok: true, value: normalized };
}

function getMappedColumnLabels(csv: MemberImportCsvData, mapping: MemberImportColumnMapping) {
  const labels: Record<string, string> = {};
  for (const definition of MEMBER_IMPORT_FIELD_DEFINITIONS) {
    const columnIndex = mapping[definition.key];
    if (columnIndex !== null) {
      labels[definition.key] = csv.headers[columnIndex]?.trim() || `Column ${columnIndex + 1}`;
    }
  }
  return labels;
}

function getColumnContext(labels: Record<string, string>, fieldKey: MemberImportFieldKey) {
  const label = labels[fieldKey];
  return label ? ` (column ${label})` : "";
}

export function buildMemberImportPreview(
  csv: MemberImportCsvData,
  mapping: MemberImportColumnMapping,
  dateFormats: MemberImportDateFormatMapping = createDefaultMemberImportDateFormatMapping()
): MemberImportPreview {
  const fileErrors: string[] = [];
  const missingRequiredFields: string[] = [];
  const hasFullNameMapping = mapping.fullName !== null;
  if (!hasFullNameMapping && mapping.firstName === null) {
    missingRequiredFields.push("First Name");
  }
  if (!hasFullNameMapping && mapping.lastName === null) {
    missingRequiredFields.push("Last Name");
  }
  if (mapping.email === null) {
    missingRequiredFields.push("Email");
  }

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
  const sourceColumnLabels = getMappedColumnLabels(csv, mapping);

  const rows: MemberImportPreviewRow[] = csv.rows.map((record) => {
    const role = getValue(record, "role").toUpperCase();
    const fullName = getValue(record, "fullName");
    const names = deriveMemberImportNameFields({
      fullName,
      firstName: getValue(record, "firstName"),
      lastName: getValue(record, "lastName"),
    });
    const values: MemberImportRowPayload = {
      firstName: names.firstName,
      lastName: names.lastName,
      email: getValue(record, "email"),
      sourceLineNumber: record.lineNumber,
      sourceColumnLabels,
    };
    const phone = getValue(record, "phone");
    const phoneCountryCode = getValue(record, "phoneCountryCode");
    const phoneAreaCode = getValue(record, "phoneAreaCode");
    const phoneNumber = getValue(record, "phoneNumber");
    const dateOfBirth = getValue(record, "dateOfBirth");
    const joinedDate = getValue(record, "joinedDate");

    if (fullName) values.fullName = fullName;
    if (phone) values.phone = phone;
    if (phoneCountryCode) values.phoneCountryCode = phoneCountryCode;
    if (phoneAreaCode) values.phoneAreaCode = phoneAreaCode;
    if (phoneNumber) values.phoneNumber = phoneNumber;
    if (dateOfBirth) values.dateOfBirth = dateOfBirth;
    if (joinedDate) values.joinedDate = joinedDate;
    values.role = role || "MEMBER";

    const errors: string[] = [];
    if (!values.firstName) errors.push("First name is required");
    if (!values.lastName) errors.push("Last name is required");
    if (!values.email) {
      errors.push("Email is required");
    } else if (!EMAIL_PATTERN.test(values.email)) {
      errors.push("Invalid email address");
    }
    const normalizedDateValues: Partial<Record<MemberImportDateFieldKey, string>> = {};
    for (const fieldKey of MEMBER_IMPORT_DATE_FIELD_KEYS) {
      const rawValue = values[fieldKey];
      if (!rawValue) continue;
      const normalized = normalizeMemberImportDateValue(rawValue, dateFormats[fieldKey]);
      if (normalized.ok) {
        normalizedDateValues[fieldKey] = normalized.value;
      } else {
        const definition = MEMBER_IMPORT_FIELD_DEFINITIONS.find((field) => field.key === fieldKey);
        errors.push(
          `${definition?.label ?? fieldKey}${getColumnContext(sourceColumnLabels, fieldKey)} ${normalized.error}`
        );
      }
    }
    if (role && !VALID_ROLES.has(role)) {
      errors.push("Role must be MEMBER or ADMIN");
    }

    return {
      lineNumber: record.lineNumber,
      sourceValues: record.values,
      values,
      normalizedDateValues,
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
