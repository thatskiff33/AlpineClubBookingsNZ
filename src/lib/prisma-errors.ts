export function hasPrismaErrorCode(
  error: unknown,
  code: string
): error is { code: string } {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code
  );
}

export function isPrismaUniqueConstraintError(error: unknown) {
  return hasPrismaErrorCode(error, "P2002");
}
