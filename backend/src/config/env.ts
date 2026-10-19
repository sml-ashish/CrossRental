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

export type GeoProvider = "stub" | "disabled";
export type StorageDriver = "local" | "s3";

const geoProviderRaw = str("GEO_PROVIDER", "disabled");
if (geoProviderRaw !== "stub" && geoProviderRaw !== "disabled") {
  throw new Error(`GEO_PROVIDER must be "stub" or "disabled", got "${geoProviderRaw}"`);
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

  geo: Object.freeze({
    provider: geoProviderRaw as GeoProvider,
    distanceCacheDays: num("DISTANCE_CACHE_DAYS", 30),
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
  }),

  // India bounding box, brief 5.2. Used by the geocode/pin-drop validators and
  // mirrored as a CHECK constraint on the cranes and rfqs tables.
  indiaBounds: Object.freeze({ minLat: 6, maxLat: 38, minLng: 68, maxLng: 98 }),

  corsOrigins: list("CORS_ORIGINS", ["http://localhost:5173"]),
});