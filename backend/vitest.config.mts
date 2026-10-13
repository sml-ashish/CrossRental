import "dotenv/config";
import os from "os";
import path from "path";
import { defineConfig } from "vitest/config";

/**
 * config/env and lib/database read process.env at import time, and ES module
 * imports are hoisted, so the test database has to be injected here rather than
 * from a beforeAll hook — otherwise the app would silently connect to the
 * development database while fixtures go to the test one.
 */
const testDatabaseUrl = process.env["TEST_DATABASE_URL"];

if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Copy .env.example to .env and point it at a scratch database.",
  );
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The isolation suite talks to a real Postgres (TEST_DATABASE_URL),
    // so files run sequentially to keep truncate/seed cycles predictable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: "test",
      // Test runs upload real files. Pointing them at a scratch directory keeps
      // them out of the development ./uploads folder; the harness removes it
      // after the run.
      STORAGE_LOCAL_DIR: path.join(os.tmpdir(), "crossrental-test-uploads"),
      // The limiter instances are created once when the app is built in
      // beforeAll, so their in-memory stores survive every resetTestDatabase()
      // and would otherwise throttle later tests. Raised here; the limits
      // themselves are asserted in rateLimit.test.ts.
      RATE_LIMIT_LOGIN_PER_15MIN: "10000",
      RATE_LIMIT_RESET_PER_15MIN: "10000",
      RATE_LIMIT_OTP_REQUEST_PER_15MIN: "10000",
      RATE_LIMIT_OTP_VERIFY_PER_15MIN: "10000",
      RATE_LIMIT_API_PER_MIN: "100000",
    },
  },
});