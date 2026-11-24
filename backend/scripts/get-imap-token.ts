import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beginDeviceCode, completeDeviceCode } from "../src/lib/imapAuth";

/**
 * One-time Entra device-code sign-in for IMAP.
 *
 * Prerequisites in the Entra app registration:
 *   - "Allow public client flows" = Yes
 *   - Delegated permissions: IMAP.AccessAsUser.All + offline_access
 *   - Admin consent granted
 *
 * Run `npm run imap:token`, open the printed URL, enter the code and sign in as
 * the mailbox owner. The refresh token is written to backend/.env; the poller
 * exchanges it for an access token on every run.
 */

async function main(): Promise<void> {
  const clientId = process.env["IMAP_CLIENT_ID"];
  const tenantId = process.env["IMAP_TENANT_ID"];
  if (!clientId || !tenantId) {
    throw new Error("Set IMAP_CLIENT_ID and IMAP_TENANT_ID in backend/.env first.");
  }

  const device = await beginDeviceCode(clientId, tenantId);
  console.log("\nSign in to the mailbox with this code:");
  console.log(`  ${device.user_code}`);
  console.log(`\nOpen: ${device.verification_uri}`);
  console.log(device.message ?? "");
  console.log("\nWaiting for approval...\n");

  const tokens = await completeDeviceCode(clientId, tenantId, device, (message) =>
    console.log(`  ${message}`),
  );
  if (!tokens.refresh_token || !tokens.access_token) {
    throw new Error(
      `Sign-in succeeded but no refresh token was returned (${tokens.error ?? "unknown reason"}). ` +
        "Check that offline_access is consented.",
    );
  }

  const envPath = path.resolve(__dirname, "..", ".env");
  const current = await readFile(envPath, "utf8").catch(() => "");
  const line = `IMAP_REFRESH_TOKEN=${tokens.refresh_token}`;
  const updated = /^IMAP_REFRESH_TOKEN=.*$/m.test(current)
    ? current.replace(/^IMAP_REFRESH_TOKEN=.*$/m, line)
    : `${current.trimEnd()}\n\n# IMAP OAuth2 refresh token (from npm run imap:token)\n${line}\n`;
  await writeFile(envPath, updated, { mode: 0o600 });
  process.env["IMAP_REFRESH_TOKEN"] = tokens.refresh_token;

  console.log("IMAP access token acquired and refresh token written to backend/.env");
  console.log("Restart the backend so the poller picks it up.");
}

main().catch((error) => {
  console.error("[imap:token] failed", error);
  process.exit(1);
});
