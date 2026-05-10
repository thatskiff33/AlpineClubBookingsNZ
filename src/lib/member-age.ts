interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseDateParts(value: Date | string | null | undefined): DateParts | null {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      year: value.getFullYear(),
      month: value.getMonth() + 1,
      day: value.getDate(),
    };
  }

  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function anniversaryDay(dateOfBirth: DateParts, year: number, month: number) {
  return Math.min(dateOfBirth.day, daysInMonth(year, month));
}

function isBeforeBirthdayInYear(dateOfBirth: DateParts, asOfDate: DateParts) {
  const birthdayDay = anniversaryDay(dateOfBirth, asOfDate.year, dateOfBirth.month);
  return (
    asOfDate.month < dateOfBirth.month ||
    (asOfDate.month === dateOfBirth.month && asOfDate.day < birthdayDay)
  );
}

function formatYearsMonths(years: number, months: number) {
  const yearLabel = years === 1 ? "year" : "years";
  const monthLabel = months === 1 ? "month" : "months";
  return `${years} ${yearLabel} ${months} ${monthLabel}`;
}

export function formatAgeYearsMonths(
  dateOfBirth: Date | string | null | undefined,
  asOfDate: Date | string = new Date()
): string | null {
  const dob = parseDateParts(dateOfBirth);
  const asOf = parseDateParts(asOfDate);
  if (!dob || !asOf) return null;

  if (
    asOf.year < dob.year ||
    (asOf.year === dob.year && asOf.month < dob.month) ||
    (asOf.year === dob.year && asOf.month === dob.month && asOf.day < dob.day)
  ) {
    return formatYearsMonths(0, 0);
  }

  let years = asOf.year - dob.year;
  if (isBeforeBirthdayInYear(dob, asOf)) {
    years -= 1;
  }

  let months = asOf.month - dob.month;
  if (months < 0) months += 12;

  const monthlyAnniversaryDay = anniversaryDay(dob, asOf.year, asOf.month);
  if (asOf.day < monthlyAnniversaryDay) {
    months -= 1;
  }
  if (months < 0) months += 12;

  return formatYearsMonths(years, months);
}
