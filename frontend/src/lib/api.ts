/**
 * Thin fetch wrapper around the backend.
 *
 * The backend is the only thing that decides what a signed-in user may see, so
 * nothing here filters by role or vendor — the UI reflects the API, it does not
 * extend the API's guarantees (brief 6.6).
 */

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

/** Mirrors the backend's AppError codes so screens can branch on them. */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_CREDENTIALS"
  | "NOT_ACTIVATED"
  | "VENDOR_NOT_APPROVED"
  | "INVALID_OTP"
  | "ACCOUNT_DEACTIVATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly details: ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level message for a form input, if the backend named a field. */
  fieldError(field: string): string | undefined {
    return this.details.find((d) => d.path === field)?.message;
  }

  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

const TOKEN_KEY = "sml.portal.token";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Skips the Authorization header, for the sign-in screens. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, anonymous = false, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (!anonymous) {
    const token = getStoredToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    // A dropped connection or a stopped backend should read as one clear
    // message rather than "Failed to fetch" in every screen.
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Please try again.");
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  let parsed = false;
  if (text) {
    try {
      payload = JSON.parse(text);
      parsed = true;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    // An empty or non-JSON 5xx is the shape a request gets when it never
    // reached the backend at all — a stopped server behind the dev proxy
    // answers with a bare 500 and no body. Reporting that as a generic
    // failure would send someone hunting for a credential problem they do
    // not have.
    if (!parsed && response.status >= 500) {
      throw new ApiError(
        response.status,
        "SERVER_UNAVAILABLE",
        "The server is not responding. Check that the backend is running, then try again.",
      );
    }

    const errorBody = (payload ?? {}) as {
      error?: string;
      code?: string;
      details?: ApiErrorDetail[] | { issues?: ApiErrorDetail[] };
    };
    const details = Array.isArray(errorBody.details)
      ? errorBody.details
      : (errorBody.details?.issues ?? []);

    throw new ApiError(
      response.status,
      errorBody.code ?? "INTERNAL_ERROR",
      errorBody.error ?? "Something went wrong. Please try again.",
      details,
    );
  }

  return payload as T;
}

/**
 * Posts a file as multipart/form-data, with any number of ordinary fields
 * alongside it.
 *
 * Deliberately separate from `api()`: the document and load-chart endpoints
 * take a file rather than JSON, and `api()` sets a JSON content type
 * unconditionally. The Content-Type header is left to the browser here so it
 * can add the multipart boundary, and the auth token is attached the same way so
 * an upload is still an authenticated request.
 *
 * `fields` matters for a submission that is *mostly* JSON with one optional
 * file — a quotation sends its rates as fields and, only if the crane has no
 * load chart of its own, a chart as the file. Booleans are stringified here
 * because multipart has no other way to carry them.
 */
export async function apiUpload<T>(
  path: string,
  file: File | null,
  options: {
    method?: "POST" | "PUT";
    token?: string;
    anonymous?: boolean;
    field?: string;
    fields?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const {
    method = "POST",
    token,
    anonymous = false,
    field = "file",
    fields = {},
  } = options;

  const headers: Record<string, string> = {};
  const authToken = anonymous ? null : (token ?? getStoredToken());
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === "boolean" ? String(value) : String(value));
  }
  if (file) {
    form.append(field, file);
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { method, headers, body: form });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the server. Please try again.");
  }

  const text = await response.text();
  let payload: unknown = null;
  let parsed = false;
  if (text) {
    try {
      payload = JSON.parse(text);
      parsed = true;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    if (!parsed && response.status >= 500) {
      throw new ApiError(
        response.status,
        "SERVER_UNAVAILABLE",
        "The server is not responding. Check that the backend is running, then try again.",
      );
    }
    const errorBody = (payload ?? {}) as {
      error?: string;
      code?: string;
      details?: ApiErrorDetail[] | { issues?: ApiErrorDetail[] };
    };
    const details = Array.isArray(errorBody.details)
      ? errorBody.details
      : (errorBody.details?.issues ?? []);
    throw new ApiError(
      response.status,
      errorBody.code ?? "INTERNAL_ERROR",
      errorBody.error ?? "The upload could not be completed.",
      details,
    );
  }

  return payload as T;
}
