export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT";

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function errorResponse(error: unknown): Response {
  if (!(error instanceof DomainError)) {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
  const statuses: Record<ErrorCode, number> = {
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    INVALID_INPUT: 400,
    CONFLICT: 409,
  };
  return Response.json(
    { error: error.code, message: error.message },
    { status: statuses[error.code] },
  );
}
