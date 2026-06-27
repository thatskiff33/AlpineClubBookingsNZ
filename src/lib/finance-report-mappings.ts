import {
  FinanceReportCategoryKind,
  FinanceSnapshotType,
  Prisma,
} from "@prisma/client";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import {
  DEFAULT_FINANCE_REPORT_CATEGORIES,
  type FinanceReportCategoryKindValue,
} from "@/lib/finance-report-mapping-defaults";
import {
  DEFAULT_FINANCE_SNAPSHOT_SCOPE,
  listFinanceSnapshots,
} from "@/lib/finance-sync-storage";
import {
  readPnlPeriodLabel,
  readPnlReportPayload,
  readRowAccountId,
  readRowAmountCents,
  readRowLabel,
  type PnlReportPayload,
  type PnlReportRow,
} from "@/lib/finance-pnl-snapshot";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

export const UNMAPPED_FINANCE_CATEGORY_ID = "unmapped";

const INCOME_SECTION_KEYWORDS = ["income", "revenue"];
const EXPENSE_SECTION_KEYWORDS = [
  "expense",
  "cost of sales",
  "cost of goods sold",
  "direct costs",
];

type FinanceSnapshotRecord = Awaited<
  ReturnType<typeof listFinanceSnapshots>
>[number];

export interface FinanceReportCategoryMappingDto {
  id?: string;
  accountCode: string | null;
  sectionLabel: string | null;
  lineLabel: string | null;
}

export interface FinanceReportCategoryDto {
  id: string;
  kind: FinanceReportCategoryKindValue;
  name: string;
  sortOrder: number;
  archived: boolean;
  mappings: FinanceReportCategoryMappingDto[];
}

export interface SaveFinanceReportCategoryInput {
  id?: string;
  kind: FinanceReportCategoryKindValue;
  name: string;
  sortOrder?: number;
  archived?: boolean;
  mappings?: FinanceReportCategoryMappingDto[];
}

export interface SaveFinanceReportMappingsInput {
  categories: SaveFinanceReportCategoryInput[];
}

export interface FinanceReportUnmappedLine {
  kind: FinanceReportCategoryKindValue;
  sectionLabel: string;
  lineLabel: string;
  accountCode: string | null;
  amountCents: number;
  formattedAmount: string;
  periodsPresent: number;
}

export interface FinanceReportMappingsState {
  categories: FinanceReportCategoryDto[];
  unmappedLines: FinanceReportUnmappedLine[];
  snapshotCoverage: {
    latestProfitAndLossSnapshot: string | null;
    inspectedSnapshotCount: number;
  };
}

export interface FinanceMappedPnlLineSummary {
  key: string;
  sectionLabel: string;
  lineLabel: string;
  accountCode: string | null;
  amountCents: number;
  comparisonAmountCents: number;
  formattedAmount: string;
  formattedComparisonAmount: string;
  formattedDelta: string;
  periodsPresent: number;
}

export interface FinanceMappedPnlCategorySummary {
  id: string;
  name: string;
  kind: FinanceReportCategoryKindValue;
  sortOrder: number;
  amountCents: number;
  comparisonAmountCents: number;
  deltaCents: number;
  formattedAmount: string;
  formattedComparisonAmount: string;
  formattedDelta: string;
  lineCount: number;
  lines: FinanceMappedPnlLineSummary[];
}

export interface FinanceMappedPnlTrendPoint {
  label: string;
  amountCents: number;
}

export interface FinanceMappedPnlSummary {
  kind: FinanceReportCategoryKindValue;
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
  amountCents: number;
  comparisonAmountCents: number;
  deltaCents: number;
  formattedAmount: string;
  formattedComparisonAmount: string;
  formattedDelta: string;
  groups: FinanceMappedPnlCategorySummary[];
  mix: Array<{ name: string; valueCents: number }>;
  trend: FinanceMappedPnlTrendPoint[];
  availableExpenseLines: Array<{
    value: string;
    label: string;
    categoryId: string;
  }>;
  warnings: string[];
  selectedSnapshotCount: number;
  comparisonSnapshotCount: number;
}

export interface BuildFinanceMappedPnlSummaryInput {
  kind: FinanceReportCategoryKindValue;
  from: string;
  to: string;
  compareFrom: string;
  compareTo: string;
  expenseCategoryId?: string | null;
  expenseLine?: string | null;
}

interface ChartOfAccountsContext {
  accountCodeById: Map<string, string>;
}

interface PnlLine {
  kind: FinanceReportCategoryKindValue;
  sectionLabel: string;
  lineLabel: string;
  accountId: string | null;
  accountCode: string | null;
  amountCents: number;
}

interface CategorizedPnlLine extends PnlLine {
  categoryId: string | null;
  categoryName: string | null;
  sortOrder: number;
}

type ActiveCategory = FinanceReportCategoryDto & {
  mappingKeys: NormalizedMappingKey[];
};

type NormalizedMappingKey =
  | { type: "account"; accountCode: string }
  | { type: "line"; sectionLabel: string | null; lineLabel: string };

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeAccountCode(value: string | null | undefined): string | null {
  return normalizeText(value)?.toUpperCase() ?? null;
}

function normalizeComparable(value: string | null | undefined): string | null {
  const trimmed = normalizeText(value);
  return trimmed ? trimmed.toLowerCase().replace(/\s+/g, " ") : null;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateOnlyString(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function snapshotStart(snapshot: FinanceSnapshotRecord): Date {
  return snapshot.periodStart ?? startOfMonthUtc(snapshot.periodEnd ?? snapshot.asOfDate);
}

function snapshotEnd(snapshot: FinanceSnapshotRecord): Date {
  return snapshot.periodEnd ?? snapshot.asOfDate;
}

function snapshotOverlapsRange(
  snapshot: FinanceSnapshotRecord,
  from: string,
  to: string
) {
  const fromDate = parseDateOnlyString(from);
  const toDate = parseDateOnlyString(to);

  return snapshotEnd(snapshot) >= fromDate && snapshotStart(snapshot) <= toDate;
}

function formatDateLabel(date: Date) {
  return date.toLocaleDateString(APP_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: APP_TIME_ZONE,
  });
}

function formatSignedCents(amountCents: number) {
  if (amountCents === 0) {
    return formatCents(0);
  }

  return `${amountCents > 0 ? "+" : "-"}${formatCents(Math.abs(amountCents))}`;
}

export async function ensureDefaultFinanceReportCategories(
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  for (const category of DEFAULT_FINANCE_REPORT_CATEGORIES) {
    await db.financeReportCategory.upsert({
      where: {
        kind_name: {
          kind: category.kind,
          name: category.name,
        },
      },
      update: {},
      create: category,
    });
  }
}

function toCategoryDto(category: {
  id: string;
  kind: FinanceReportCategoryKind;
  name: string;
  sortOrder: number;
  archived: boolean;
  mappings: Array<{
    id: string;
    accountCode: string | null;
    sectionLabel: string | null;
    lineLabel: string | null;
  }>;
}): FinanceReportCategoryDto {
  return {
    id: category.id,
    kind: category.kind,
    name: category.name,
    sortOrder: category.sortOrder,
    archived: category.archived,
    mappings: category.mappings.map((mapping) => ({
      id: mapping.id,
      accountCode: mapping.accountCode,
      sectionLabel: mapping.sectionLabel,
      lineLabel: mapping.lineLabel,
    })),
  };
}

export async function listFinanceReportCategories(): Promise<
  FinanceReportCategoryDto[]
> {
  await ensureDefaultFinanceReportCategories();

  const categories = await prisma.financeReportCategory.findMany({
    include: {
      mappings: {
        orderBy: [{ accountCode: "asc" }, { sectionLabel: "asc" }, { lineLabel: "asc" }],
      },
    },
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });

  return categories.map(toCategoryDto);
}

function buildNormalizedMappingKeys(
  category: FinanceReportCategoryDto
): NormalizedMappingKey[] {
  return category.mappings.flatMap((mapping): NormalizedMappingKey[] => {
    const accountCode = normalizeAccountCode(mapping.accountCode);
    if (accountCode) {
      return [{ type: "account" as const, accountCode }];
    }

    const lineLabel = normalizeComparable(mapping.lineLabel);
    if (!lineLabel) {
      return [];
    }

    return [
      {
        type: "line" as const,
        sectionLabel: normalizeComparable(mapping.sectionLabel),
        lineLabel,
      },
    ];
  });
}

function activeCategoriesForKind(
  categories: FinanceReportCategoryDto[],
  kind: FinanceReportCategoryKindValue
): ActiveCategory[] {
  return categories
    .filter((category) => category.kind === kind && !category.archived)
    .map((category) => ({
      ...category,
      mappingKeys: buildNormalizedMappingKeys(category),
    }));
}

function mappingDuplicateKey(mapping: FinanceReportCategoryMappingDto) {
  const accountCode = normalizeAccountCode(mapping.accountCode);
  if (accountCode) {
    return `account:${accountCode}`;
  }

  const lineLabel = normalizeComparable(mapping.lineLabel);
  if (!lineLabel) {
    return null;
  }

  return `line:${normalizeComparable(mapping.sectionLabel) ?? "*"}:${lineLabel}`;
}

function normalizeMappingsInput(
  mappings: FinanceReportCategoryMappingDto[] | undefined
) {
  const normalized: Array<{
    accountCode: string | null;
    sectionLabel: string | null;
    lineLabel: string | null;
  }> = [];

  for (const mapping of mappings ?? []) {
    const accountCode = normalizeAccountCode(mapping.accountCode);
    const sectionLabel = normalizeText(mapping.sectionLabel);
    const lineLabel = normalizeText(mapping.lineLabel);

    if (!accountCode && !lineLabel) {
      continue;
    }

    normalized.push({
      accountCode,
      sectionLabel,
      lineLabel,
    });
  }

  return normalized;
}

export function validateFinanceReportMappingsInput(
  input: SaveFinanceReportMappingsInput
) {
  const errors: string[] = [];
  const seenCategoryNames = new Set<string>();
  const seenMappings = new Map<string, string>();

  if (!Array.isArray(input.categories) || input.categories.length === 0) {
    errors.push("At least one finance report category is required.");
    return errors;
  }

  input.categories.forEach((category, index) => {
    if (category.kind !== "REVENUE" && category.kind !== "EXPENSE") {
      errors.push(`Category ${index + 1} has an invalid kind.`);
    }

    const name = normalizeText(category.name);
    if (!name) {
      errors.push(`Category ${index + 1} needs a name.`);
    } else if (name.length > 120) {
      errors.push(`Category ${name} must be 120 characters or fewer.`);
    } else {
      const key = `${category.kind}:${name.toLowerCase()}`;
      if (seenCategoryNames.has(key)) {
        errors.push(`Category ${name} is duplicated for ${category.kind}.`);
      }
      seenCategoryNames.add(key);
    }

    if (
      category.sortOrder !== undefined &&
      (!Number.isInteger(category.sortOrder) || category.sortOrder < 0)
    ) {
      errors.push(`Category ${name ?? index + 1} sort order must be a non-negative integer.`);
    }

    for (const mapping of normalizeMappingsInput(category.mappings)) {
      const key = mappingDuplicateKey(mapping);
      if (!key) {
        continue;
      }

      const owner = `${category.kind}:${name ?? index + 1}`;
      const existingOwner = seenMappings.get(`${category.kind}:${key}`);
      if (existingOwner && existingOwner !== owner) {
        errors.push(
          `Mapping ${key.replace(/^account:/, "account ")} is assigned to both ${existingOwner} and ${owner}.`
        );
      }
      seenMappings.set(`${category.kind}:${key}`, owner);
    }
  });

  return errors;
}

export async function saveFinanceReportMappings(input: SaveFinanceReportMappingsInput) {
  const errors = validateFinanceReportMappingsInput(input);
  if (errors.length > 0) {
    const error = new Error("Invalid finance report mappings");
    (error as Error & { validationErrors?: string[] }).validationErrors = errors;
    throw error;
  }

  await prisma.$transaction(async (tx) => {
    await ensureDefaultFinanceReportCategories(tx);

    for (const category of input.categories) {
      const name = normalizeText(category.name)!;
      const data = {
        kind: category.kind,
        name,
        sortOrder: category.sortOrder ?? 0,
        archived: Boolean(category.archived),
      };

      const record = category.id
        ? await tx.financeReportCategory.update({
            where: { id: category.id },
            data,
          })
        : await tx.financeReportCategory.upsert({
            where: {
              kind_name: {
                kind: category.kind,
                name,
              },
            },
            update: data,
            create: data,
          });

      await tx.financeReportCategoryMapping.deleteMany({
        where: { categoryId: record.id },
      });

      const mappings = normalizeMappingsInput(category.mappings);
      if (mappings.length > 0) {
        await tx.financeReportCategoryMapping.createMany({
          data: mappings.map((mapping) => ({
            categoryId: record.id,
            ...mapping,
          })),
        });
      }
    }
  });
}

function parseChartOfAccountsMap(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return map;
  }

  const accounts = (payload as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) {
    return map;
  }

  for (const entry of accounts) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const rawAccountId = (entry as { accountId?: unknown }).accountId;
    const rawCode = (entry as { code?: unknown }).code;
    const accountId =
      typeof rawAccountId === "string" ? normalizeText(rawAccountId) : null;
    const code =
      typeof rawCode === "string" ? normalizeAccountCode(rawCode) : null;
    if (accountId && code) {
      map.set(accountId, code);
    }
  }

  return map;
}

async function loadChartOfAccountsContext(): Promise<ChartOfAccountsContext> {
  const snapshots = await listFinanceSnapshots({
    snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
    scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
    limit: 1,
  });

  return {
    accountCodeById: parseChartOfAccountsMap(snapshots[0]?.payload),
  };
}

function findPnlSections(
  rows: PnlReportRow[],
  keywords: string[]
): PnlReportRow[] {
  const sections: PnlReportRow[] = [];

  const visit = (row: PnlReportRow) => {
    const title = row.title?.toLowerCase();
    if (
      row.rowType?.toLowerCase() === "section" &&
      title &&
      keywords.some((keyword) => title.includes(keyword))
    ) {
      sections.push(row);
      return;
    }

    for (const nested of row.rows) {
      visit(nested);
    }
  };

  for (const row of rows) {
    visit(row);
  }

  return sections;
}

function extractLinesFromSection(input: {
  section: PnlReportRow;
  kind: FinanceReportCategoryKindValue;
  chart: ChartOfAccountsContext;
}) {
  const lines: PnlLine[] = [];

  const visit = (row: PnlReportRow, sectionPath: string[]) => {
    const nextSectionPath =
      row.rowType?.toLowerCase() === "section" && row.title
        ? [...sectionPath, row.title]
        : sectionPath;

    if (row.rowType?.toLowerCase() === "row") {
      const lineLabel = readRowLabel(row);
      const amountCents = readRowAmountCents(row);

      if (
        lineLabel &&
        amountCents !== null &&
        !lineLabel.toLowerCase().includes("total")
      ) {
        const accountId = readRowAccountId(row);
        lines.push({
          kind: input.kind,
          sectionLabel:
            nextSectionPath.length > 0
              ? nextSectionPath.join(" / ")
              : input.section.title ?? "Uncategorised",
          lineLabel,
          accountId,
          accountCode: accountId
            ? input.chart.accountCodeById.get(accountId) ?? null
            : null,
          amountCents,
        });
      }
    }

    for (const nested of row.rows) {
      visit(nested, nextSectionPath);
    }
  };

  for (const row of input.section.rows) {
    visit(row, input.section.title ? [input.section.title] : []);
  }

  return lines;
}

function extractPnlLines(input: {
  payload: PnlReportPayload;
  kind: FinanceReportCategoryKindValue;
  chart: ChartOfAccountsContext;
}) {
  const keywords =
    input.kind === "REVENUE" ? INCOME_SECTION_KEYWORDS : EXPENSE_SECTION_KEYWORDS;
  const sections = findPnlSections(input.payload.rows, keywords);

  return sections.flatMap((section) =>
    extractLinesFromSection({
      section,
      kind: input.kind,
      chart: input.chart,
    })
  );
}

function matchCategory(
  line: PnlLine,
  categories: ActiveCategory[]
): ActiveCategory | null {
  const lineAccountCode = normalizeAccountCode(line.accountCode);
  if (lineAccountCode) {
    const accountMatch = categories.find((category) =>
      category.mappingKeys.some(
        (mapping) =>
          mapping.type === "account" && mapping.accountCode === lineAccountCode
      )
    );
    if (accountMatch) {
      return accountMatch;
    }
  }

  const lineSection = normalizeComparable(line.sectionLabel);
  const lineLabel = normalizeComparable(line.lineLabel);
  if (!lineLabel) {
    return null;
  }

  return (
    categories.find((category) =>
      category.mappingKeys.some((mapping) => {
        if (mapping.type !== "line" || mapping.lineLabel !== lineLabel) {
          return false;
        }
        return !mapping.sectionLabel || mapping.sectionLabel === lineSection;
      })
    ) ?? null
  );
}

function categorizeLines(input: {
  lines: PnlLine[];
  categories: ActiveCategory[];
}): CategorizedPnlLine[] {
  return input.lines.map((line) => {
    const category = matchCategory(line, input.categories);

    return {
      ...line,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      sortOrder: category?.sortOrder ?? 9999,
    };
  });
}

function loadSnapshotLines(input: {
  snapshots: FinanceSnapshotRecord[];
  kind: FinanceReportCategoryKindValue;
  categories: ActiveCategory[];
  chart: ChartOfAccountsContext;
}) {
  return input.snapshots.map((snapshot) => {
    const payload = readPnlReportPayload(snapshot.payload);
    const label =
      (payload ? readPnlPeriodLabel(payload) : null) ??
      formatDateLabel(snapshotEnd(snapshot));
    const lines = payload
      ? categorizeLines({
          lines: extractPnlLines({
            payload,
            kind: input.kind,
            chart: input.chart,
          }),
          categories: input.categories,
        })
      : [];

    return { snapshot, label, lines };
  });
}

function lineKey(line: CategorizedPnlLine) {
  return `${line.sectionLabel}::${line.lineLabel}::${line.accountCode ?? ""}`;
}

function aggregateCategoryLines(
  selectedLines: CategorizedPnlLine[],
  comparisonLines: CategorizedPnlLine[]
) {
  const lineMap = new Map<
    string,
    {
      line: CategorizedPnlLine;
      amountCents: number;
      comparisonAmountCents: number;
      periods: Set<string>;
    }
  >();

  for (const line of selectedLines) {
    const key = lineKey(line);
    const existing = lineMap.get(key) ?? {
      line,
      amountCents: 0,
      comparisonAmountCents: 0,
      periods: new Set<string>(),
    };
    existing.amountCents += line.amountCents;
    existing.periods.add(`${line.sectionLabel}:${line.lineLabel}`);
    lineMap.set(key, existing);
  }

  for (const line of comparisonLines) {
    const key = lineKey(line);
    const existing = lineMap.get(key) ?? {
      line,
      amountCents: 0,
      comparisonAmountCents: 0,
      periods: new Set<string>(),
    };
    existing.comparisonAmountCents += line.amountCents;
    lineMap.set(key, existing);
  }

  return Array.from(lineMap.entries())
    .map(([key, entry]) => ({
      key,
      sectionLabel: entry.line.sectionLabel,
      lineLabel: entry.line.lineLabel,
      accountCode: entry.line.accountCode,
      amountCents: entry.amountCents,
      comparisonAmountCents: entry.comparisonAmountCents,
      formattedAmount: formatCents(entry.amountCents),
      formattedComparisonAmount: formatCents(entry.comparisonAmountCents),
      formattedDelta: formatSignedCents(
        entry.amountCents - entry.comparisonAmountCents
      ),
      periodsPresent: entry.periods.size,
    }))
    .sort((left, right) => {
      if (right.amountCents !== left.amountCents) {
        return right.amountCents - left.amountCents;
      }
      return left.lineLabel.localeCompare(right.lineLabel);
    });
}

function buildCategorySummary(input: {
  category: Pick<FinanceReportCategoryDto, "id" | "name" | "kind" | "sortOrder">;
  selectedLines: CategorizedPnlLine[];
  comparisonLines: CategorizedPnlLine[];
}): FinanceMappedPnlCategorySummary {
  const amountCents = input.selectedLines.reduce(
    (total, line) => total + line.amountCents,
    0
  );
  const comparisonAmountCents = input.comparisonLines.reduce(
    (total, line) => total + line.amountCents,
    0
  );
  const deltaCents = amountCents - comparisonAmountCents;
  const lines = aggregateCategoryLines(input.selectedLines, input.comparisonLines);

  return {
    id: input.category.id,
    name: input.category.name,
    kind: input.category.kind,
    sortOrder: input.category.sortOrder,
    amountCents,
    comparisonAmountCents,
    deltaCents,
    formattedAmount: formatCents(amountCents),
    formattedComparisonAmount: formatCents(comparisonAmountCents),
    formattedDelta: formatSignedCents(deltaCents),
    lineCount: lines.length,
    lines,
  };
}

export async function buildFinanceMappedPnlSummary(
  input: BuildFinanceMappedPnlSummaryInput
): Promise<FinanceMappedPnlSummary> {
  const [allCategories, chart, snapshots] = await Promise.all([
    listFinanceReportCategories(),
    loadChartOfAccountsContext(),
    listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: 100,
    }),
  ]);
  const categories = activeCategoriesForKind(allCategories, input.kind);
  const selectedSnapshots = snapshots.filter((snapshot) =>
    snapshotOverlapsRange(snapshot, input.from, input.to)
  );
  const comparisonSnapshots = snapshots.filter((snapshot) =>
    snapshotOverlapsRange(snapshot, input.compareFrom, input.compareTo)
  );
  const warnings: string[] = [];

  if (selectedSnapshots.length === 0) {
    warnings.push(
      `No stored monthly profit-and-loss snapshots cover ${input.from} to ${input.to}.`
    );
  }
  if (comparisonSnapshots.length === 0) {
    warnings.push(
      `No comparison profit-and-loss snapshots cover ${input.compareFrom} to ${input.compareTo}.`
    );
  }
  if (chart.accountCodeById.size === 0) {
    warnings.push(
      "Chart-of-accounts snapshots are not available yet, so category matching is using fallback P&L labels only."
    );
  }

  const selectedBySnapshot = loadSnapshotLines({
    snapshots: selectedSnapshots,
    kind: input.kind,
    categories,
    chart,
  });
  const comparisonLines = loadSnapshotLines({
    snapshots: comparisonSnapshots,
    kind: input.kind,
    categories,
    chart,
  }).flatMap((snapshot) => snapshot.lines);
  const selectedLines = selectedBySnapshot.flatMap((snapshot) => snapshot.lines);

  const selectedCategoryId = normalizeText(input.expenseCategoryId);
  const selectedExpenseLine = normalizeText(input.expenseLine);
  const filteredSelectedLines =
    input.kind === "EXPENSE"
      ? selectedLines.filter((line) => {
          const categoryId = line.categoryId ?? UNMAPPED_FINANCE_CATEGORY_ID;
          if (selectedCategoryId && selectedCategoryId !== categoryId) {
            return false;
          }
          if (selectedExpenseLine && line.lineLabel !== selectedExpenseLine) {
            return false;
          }
          return true;
        })
      : selectedLines;
  const filteredComparisonLines =
    input.kind === "EXPENSE"
      ? comparisonLines.filter((line) => {
          const categoryId = line.categoryId ?? UNMAPPED_FINANCE_CATEGORY_ID;
          if (selectedCategoryId && selectedCategoryId !== categoryId) {
            return false;
          }
          if (selectedExpenseLine && line.lineLabel !== selectedExpenseLine) {
            return false;
          }
          return true;
        })
      : comparisonLines;

  const categorySummaries = categories.map((category) =>
    buildCategorySummary({
      category,
      selectedLines: filteredSelectedLines.filter(
        (line) => line.categoryId === category.id
      ),
      comparisonLines: filteredComparisonLines.filter(
        (line) => line.categoryId === category.id
      ),
    })
  );
  const unmappedSummary = buildCategorySummary({
    category: {
      id: UNMAPPED_FINANCE_CATEGORY_ID,
      name: "Unmapped",
      kind: input.kind,
      sortOrder: 9999,
    },
    selectedLines: filteredSelectedLines.filter((line) => !line.categoryId),
    comparisonLines: filteredComparisonLines.filter((line) => !line.categoryId),
  });
  const groups = [...categorySummaries, unmappedSummary]
    .filter(
      (group) =>
        group.amountCents !== 0 ||
        group.comparisonAmountCents !== 0 ||
        group.lineCount > 0
    )
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }
      return left.name.localeCompare(right.name);
    });
  const amountCents = filteredSelectedLines.reduce(
    (total, line) => total + line.amountCents,
    0
  );
  const comparisonAmountCents = filteredComparisonLines.reduce(
    (total, line) => total + line.amountCents,
    0
  );
  const deltaCents = amountCents - comparisonAmountCents;
  const availableExpenseLines = Array.from(
    new Map(
      selectedLines.map((line) => [
        `${line.categoryId ?? UNMAPPED_FINANCE_CATEGORY_ID}:${line.lineLabel}`,
        {
          value: line.lineLabel,
          label: line.lineLabel,
          categoryId: line.categoryId ?? UNMAPPED_FINANCE_CATEGORY_ID,
        },
      ])
    ).values()
  ).sort((left, right) => left.label.localeCompare(right.label));

  return {
    kind: input.kind,
    from: input.from,
    to: input.to,
    compareFrom: input.compareFrom,
    compareTo: input.compareTo,
    amountCents,
    comparisonAmountCents,
    deltaCents,
    formattedAmount: formatCents(amountCents),
    formattedComparisonAmount: formatCents(comparisonAmountCents),
    formattedDelta: formatSignedCents(deltaCents),
    groups,
    mix: groups.map((group) => ({
      name: group.name,
      valueCents: group.amountCents,
    })),
    trend: selectedBySnapshot
      .map((snapshot) => ({
        label: snapshot.label,
        amountCents: snapshot.lines
          .filter((line) => {
            const categoryId = line.categoryId ?? UNMAPPED_FINANCE_CATEGORY_ID;
            if (selectedCategoryId && selectedCategoryId !== categoryId) {
              return false;
            }
            if (selectedExpenseLine && line.lineLabel !== selectedExpenseLine) {
              return false;
            }
            return true;
          })
          .reduce((total, line) => total + line.amountCents, 0),
      }))
      .reverse(),
    availableExpenseLines,
    warnings,
    selectedSnapshotCount: selectedSnapshots.length,
    comparisonSnapshotCount: comparisonSnapshots.length,
  };
}

export async function getFinanceReportMappingsState(): Promise<FinanceReportMappingsState> {
  const [categories, chart, snapshots] = await Promise.all([
    listFinanceReportCategories(),
    loadChartOfAccountsContext(),
    listFinanceSnapshots({
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: DEFAULT_FINANCE_SNAPSHOT_SCOPE,
      limit: 12,
    }),
  ]);

  const linesByKind = (["REVENUE", "EXPENSE"] as const).flatMap((kind) => {
    const activeCategories = activeCategoriesForKind(categories, kind);
    return loadSnapshotLines({
      snapshots,
      kind,
      categories: activeCategories,
      chart,
    }).flatMap((snapshot) => snapshot.lines);
  });

  const unmappedByKey = new Map<
    string,
    {
      line: CategorizedPnlLine;
      amountCents: number;
      periodsPresent: number;
    }
  >();

  for (const line of linesByKind) {
    if (line.categoryId) {
      continue;
    }
    const key = `${line.kind}:${line.sectionLabel}:${line.lineLabel}:${line.accountCode ?? ""}`;
    const existing = unmappedByKey.get(key) ?? {
      line,
      amountCents: 0,
      periodsPresent: 0,
    };
    existing.amountCents += line.amountCents;
    existing.periodsPresent += 1;
    unmappedByKey.set(key, existing);
  }

  const latest = snapshots[0] ?? null;

  return {
    categories,
    unmappedLines: Array.from(unmappedByKey.values())
      .map((entry) => ({
        kind: entry.line.kind,
        sectionLabel: entry.line.sectionLabel,
        lineLabel: entry.line.lineLabel,
        accountCode: entry.line.accountCode,
        amountCents: entry.amountCents,
        formattedAmount: formatCents(entry.amountCents),
        periodsPresent: entry.periodsPresent,
      }))
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind.localeCompare(right.kind);
        }
        return right.amountCents - left.amountCents;
      }),
    snapshotCoverage: {
      latestProfitAndLossSnapshot: latest
        ? `${dateOnly(snapshotStart(latest))} to ${dateOnly(snapshotEnd(latest))}`
        : null,
      inspectedSnapshotCount: snapshots.length,
    },
  };
}
