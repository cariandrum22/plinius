/**
 * Normalized backend errors. Backend-specific failures are mapped to a small,
 * stable set of kinds so callers never depend on a vendor's error shape.
 */
export type BackendErrorKind =
  | "unavailable"
  | "auth"
  | "not_found"
  | "timeout"
  | "rate_limit"
  | "invalid_request"
  | "invalid_response"
  | "network"
  | "unknown";

export class BackendError extends Error {
  readonly kind: BackendErrorKind;
  readonly backend: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    kind: BackendErrorKind,
    message: string,
    options: { backend: string; status?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    this.backend = options.backend;
    this.status = options.status;
    this.cause = options.cause;
  }
}

/** Map an HTTP status to a backend error kind. */
export function kindFromStatus(status: number): BackendErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500) return "unavailable";
  return "unknown";
}
