import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  call,
  clearTestUploads,
  disconnectTestDatabases,
  internalToken,
  resetTestDatabase,
  seedIsolationFixtures,
  useTestDatabase,
} from "./harness";
import { INTERNAL_USERS } from "./fixtures";
import { setSetting } from "../utils/settings";

/**
 * The settings surface (brief 6.4 / phase A): admin-only read and write of the
 * day basis, which decides how quoted months convert into days.
 */

let app: Express;

beforeAll(async () => {
  useTestDatabase();
  const { createApp } = await import("../index");
  app = createApp();
  await setSetting("RATE_DAY_BASIS", "CALENDAR_DAYS", "tests");
});

beforeEach(async () => {
  await resetTestDatabase();
  await setSetting("RATE_DAY_BASIS", "CALENDAR_DAYS", "tests");
});

afterAll(async () => {
  await disconnectTestDatabases();
  await clearTestUploads();
});

describe("settings", () => {
  it("refuses sales users on both ends", async () => {
    const fixtures = await seedIsolationFixtures();
    const token = await internalToken(
      fixtures.salesId,
      INTERNAL_USERS.sales,
      "sales_user",
    );
    const read = await call(app, "GET", "/api/settings", { token });
    expect(read.status).toBe(403);
    const write = await call(app, "PATCH", "/api/settings", {
      token,
      body: { rateDayBasis: "WORKING_DAYS_PER_MONTH" },
    });
    expect(write.status).toBe(403);
  });

  it("lets the admin read and change the day basis", async () => {
    const fixtures = await seedIsolationFixtures();
    const token = await internalToken(
      fixtures.adminId,
      INTERNAL_USERS.admin,
      "admin_user",
    );

    const before = await call(app, "GET", "/api/settings", { token });
    expect(before.status).toBe(200);
    expect(before.body.settings.rateDayBasis).toBe("CALENDAR_DAYS");

    const write = await call(app, "PATCH", "/api/settings", {
      token,
      body: { rateDayBasis: "WORKING_DAYS_PER_MONTH" },
    });
    expect(write.status).toBe(200);

    const after = await call(app, "GET", "/api/settings", { token });
    expect(after.body.settings.rateDayBasis).toBe("WORKING_DAYS_PER_MONTH");
  });

  it("refuses a vendor user", async () => {
    await seedIsolationFixtures();
    const res = await call(app, "GET", "/api/settings", { token: "garbage" });
    expect(res.status).toBe(401);
  });
});
