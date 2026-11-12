import "dotenv/config";

/**
 * Single place where environment variables are read. Everything is read once
 * at boot and frozen, so a missing or malformed value fails immediately with
 * a clear message instead of surfacing as a confusing runtime error later.
 *
 * Secrets (SMTP password, encryption key, JWT secret) live here and nowhere
 * else — they are never written to a log or an audit row.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type GeoProvider = "stub" | "disabled" | "google";
export type StorageDriver = "local" | "s3";
export type SsoProviderName = "disabled" | "entra";
export type WhatsAppProviderName = "disabled" | "meta";

// The mapping provider decision is no longer open: Google Maps is wired up for
// geocoding and road distance. "stub" stays the development/test default and
// "disabled" the production default, so a deployment that has not been given a
// key fails closed (unverified locations, no distances) rather than inventing
// coordinates.
const geoProviderDefault =
  str("NODE_ENV", "development") === "production" ? "disabled" : "stub";
const geoProviderRaw = str("GEO_PROVIDER", geoProviderDefault);
if (geoProviderRaw !== "stub" && geoProviderRaw !== "disabled" && geoProviderRaw !== "google") {
  throw new Error(
    `GEO_PROVIDER must be "google", "stub" or "disabled", got "${geoProviderRaw}"`,
  );
}

const googleMapsServerApiKey = process.env["GOOGLE_MAPS_SERVER_API_KEY"]?.trim() || null;
if (geoProviderRaw === "google" && !googleMapsServerApiKey) {
  throw new Error(
    'GEO_PROVIDER is "google" but GOOGLE_MAPS_SERVER_API_KEY is empty. Set the server key or change GEO_PROVIDER.',
  );
}

const ssoProviderRaw = str("SSO_PROVIDER", "disabled");
if (ssoProviderRaw !== "disabled" && ssoProviderRaw !== "entra") {
  throw new Error(`SSO_PROVIDER must be "disabled" or "entra", got "${ssoProviderRaw}"`);
}

const whatsappProviderRaw = str("WHATSAPP_PROVIDER", "disabled");
if (whatsappProviderRaw !== "disabled" && whatsappProviderRaw !== "meta") {
  throw new Error(
    `WHATSAPP_PROVIDER must be "disabled" or "meta", got "${whatsappProviderRaw}"`,
  );
}

const storageDriverRaw = str("STORAGE_DRIVER", "local");
if (storageDriverRaw !== "local" && storageDriverRaw !== "s3") {
  throw new Error(`STORAGE_DRIVER must be "local" or "s3", got "${storageDriverRaw}"`);
}

export const env = Object.freeze({
  nodeEnv: str("NODE_ENV", "development"),
  isProduction: str("NODE_ENV", "development") === "production",
  port: num("PORT", 4000),
  appUrl: str("APP_URL", "http://localhost:5173").replace(/\/+$/, ""),

  databaseUrl: required("DATABASE_URL"),
  testDatabaseUrl: process.env["TEST_DATABASE_URL"] ?? null,

  auth: Object.freeze({
    jwtSecret: required("JWT_SECRET"),
    jwtExpiresIn: str("JWT_EXPIRES_IN", "12h"),
    vendorPasswordMinLength: num("VENDOR_PASSWORD_MIN_LENGTH", 10),
    activationTokenTtlHours: num("ACTIVATION_TOKEN_TTL_HOURS", 24),
    passwordResetTtlHours: num("PASSWORD_RESET_TTL_HOURS", 1),
    loginOtpTtlMinutes: num("LOGIN_OTP_TTL_MINUTES", 10),
    loginOtpMaxAttempts: num("LOGIN_OTP_MAX_ATTEMPTS", 5),
    // UAT only: return the code in the request response so testers do not need
    // inbox access. Never enable this in production.
    exposeOtp: bool("EXPOSE_OTP", false),
  }),

  rateLimits: Object.freeze({
    loginPer15Min: num("RATE_LIMIT_LOGIN_PER_15MIN", 10),
    resetPer15Min: num("RATE_LIMIT_RESET_PER_15MIN", 5),
    otpRequestPer15Min: num("RATE_LIMIT_OTP_REQUEST_PER_15MIN", 5),
    otpVerifyPer15Min: num("RATE_LIMIT_OTP_VERIFY_PER_15MIN", 10),
    apiPerMin: num("RATE_LIMIT_API_PER_MIN", 600),
  }),

  mail: Object.freeze({
    host: required("SMTP_HOST"),
    port: num("SMTP_PORT", 587),
    secure: bool("SMTP_SECURE", false),
    user: required("SMTP_USER"),
    pass: required("SMTP_PASS"),
    from: str("MAIL_FROM", "SML Crane Portal <no-reply@sanghvimovers.com>"),
    internalNotifyEmail: str("INTERNAL_NOTIFY_EMAIL", required("SMTP_USER")),
  }),

  fieldEncryptionKey: required("FIELD_ENCRYPTION_KEY"),

  // P5 SSO. Open item 8's working assumption is Microsoft Entra ID with OTP
  // kept as the fallback. The provider is disabled unless all four Entra
  // values are present, so a misconfigured deploy fails closed.
  sso: Object.freeze({
    provider: ssoProviderRaw as SsoProviderName,
    tenantId: process.env["SSO_TENANT_ID"] ?? null,
    clientId: process.env["SSO_CLIENT_ID"] ?? null,
    clientSecret: process.env["SSO_CLIENT_SECRET"] ?? null,
    redirectUri: process.env["SSO_REDIRECT_URI"] ?? null,
    allowedDomains: list("SSO_ALLOWED_DOMAINS", ["sanghvimovers.com"]),
  }),

  // P6: WhatsApp Cloud API. The provider is inert until the phone number id,
  // access token and approved template are all present, so a half-configured
  // deployment cannot silently send through the wrong sender.
  whatsapp: Object.freeze({
    provider: whatsappProviderRaw as WhatsAppProviderName,
    apiVersion: str("WHATSAPP_API_VERSION", "v22.0"),
    phoneNumberId: process.env["WHATSAPP_PHONE_NUMBER_ID"] ?? null,
    accessToken: process.env["WHATSAPP_ACCESS_TOKEN"] ?? null,
    verifyToken: process.env["WHATSAPP_VERIFY_TOKEN"] ?? null,
    appSecret: process.env["WHATSAPP_APP_SECRET"] ?? null,
    templateName: process.env["WHATSAPP_TEMPLATE_NAME"] ?? null,
    templateLanguage: str("WHATSAPP_TEMPLATE_LANGUAGE", "en"),
  }),

  // P6: inbound email replies are polled from the shared mailbox. Polling is
  // off unless a host and credentials are present, so tests and local builds
  // never try to reach a real mailbox.
  imap: Object.freeze({
    enabled: bool("IMAP_POLL_ENABLED", false),
    host: process.env["IMAP_HOST"] ?? null,
    port: num("IMAP_PORT", 993),
    secure: bool("IMAP_SECURE", true),
    user: process.env["IMAP_USER"] ?? null,
    pass: process.env["IMAP_PASS"] ?? null,
    mailbox: str("IMAP_MAILBOX", "INBOX"),
  }),

  onboarding: Object.freeze({
    // How long an invitation link stays usable. The vendor gets a reminder
    // before it lapses rather than the link simply dying.
    invitationTtlDays: num("ONBOARDING_INVITATION_TTL_DAYS", 7),
    // Rejection remarks are emailed; this is how long a rejected vendor keeps
    // access to the link in order to correct and resubmit.
    resubmitWindowDays: num("ONBOARDING_RESUBMIT_WINDOW_DAYS", 30),
  }),

  storage: Object.freeze({
    driver: storageDriverRaw as StorageDriver,
    localDir: str("STORAGE_LOCAL_DIR", "./uploads"),
    uploadMaxBytes: num("UPLOAD_MAX_MB", 10) * 1024 * 1024,
    s3Bucket: process.env["AWS_S3_BUCKET"] ?? null,
    s3Region: process.env["AWS_REGION"] ?? null,
    s3AccessKeyId: process.env["AWS_ACCESS_KEY_ID"] ?? null,
    s3SecretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"] ?? null,
  }),

  // Google Maps: the Geocoding API resolves addresses and the Routes API
  // (computeRoutes) measures road distance. Only the server key lives here; the
  // browser gets its own referrer-restricted key through Vite.
  geo: Object.freeze({
    provider: geoProviderRaw as GeoProvider,
    distanceCacheDays: num("DISTANCE_CACHE_DAYS", 30),
    googleServerApiKey: googleMapsServerApiKey,
    googleRegion: str("GOOGLE_MAPS_REGION", "IN"),
    googleLanguage: str("GOOGLE_MAPS_LANGUAGE", "en"),
    googleTimeoutMs: num("GOOGLE_MAPS_TIMEOUT_MS", 8_000),
  }),

  // Seeded into app_settings on first run; the DB copy is what the app reads
  // afterwards so the thresholds can be changed without a redeploy.
  defaultSettings: Object.freeze({
    FLEET_APPROVAL_REQUIRED: bool("FLEET_APPROVAL_REQUIRED", false),
    STALE_DUE_DAYS: num("STALE_DUE_DAYS", 30),
    STALE_FLAG_DAYS: num("STALE_FLAG_DAYS", 60),
    STALE_REMINDER_REPEAT_DAYS: num("STALE_REMINDER_REPEAT_DAYS", 7),
    RFQ_REMINDER_LEAD_HOURS: num("RFQ_REMINDER_LEAD_HOURS", 24),
    // Brief C2: a response window shorter than this is never auto-reminded —
    // there is no room to chase, only a deadline to meet.
    RFQ_REMINDER_MIN_WINDOW_HOURS: num("RFQ_REMINDER_MIN_WINDOW_HOURS", 4),
    // Brief 6: how a quoted month converts into days for the total. The
    // calendar default keeps M5's arithmetic; working days uses each RFQ's
    // captured working_days_per_month.
    RATE_DAY_BASIS: str("RATE_DAY_BASIS", "CALENDAR_DAYS"),
    // P3: the comparison screen's default sort. Open item 5's working
    // assumption — total estimated cost ascending.
    QUOTE_RANK_RULE: str("QUOTE_RANK_RULE", "TOTAL_ESTIMATED_COST"),
    // P5 alert SLAs (open item 11) and the report retention window. These are
    // seeded once; the database copy is authoritative afterwards.
    ALERT_RFQ_SLA_HOURS: num("ALERT_RFQ_SLA_HOURS", 48),
    ALERT_QUOTATION_EXPIRY_DAYS: num("ALERT_QUOTATION_EXPIRY_DAYS", 3),
    ALERT_BOOKING_LEAD_DAYS: num("ALERT_BOOKING_LEAD_DAYS", 7),
    ALERT_EMAILS_ENABLED: bool("ALERT_EMAILS_ENABLED", true),
    REPORT_RETENTION_MONTHS: num("REPORT_RETENTION_MONTHS", 84),
  }),

  // India bounding box, brief 5.2. Used by the geocode/pin-drop validators and
  // mirrored as a CHECK constraint on the cranes and rfqs tables.
  indiaBounds: Object.freeze({ minLat: 6, maxLat: 38, minLng: 68, maxLng: 98 }),

  corsOrigins: list("CORS_ORIGINS", ["http://localhost:5173"]),
});