import { describe, expect, it } from "vitest";
import express, { Request, Response } from "express";
import { credentialLimit, loginLimiter, otpVerifyLimiter, resetLimiter } from "../middleware/rateLimiter";

/**
 * Brief 6.6: login and password reset must be rate limited.
 *
 * `credentialLimit` is exercised directly at a low threshold so the 429 path
 * is covered without waiting out a fifteen-minute window. The production
 * limiters come from env and are far higher; what matters here is that the
 * shared factory applies the IP+email key and the JSON error contract.
 */

async function hit(app: express.Express, path: string, body: unknown, times: number) {
  const http = await import("http");
  const statuses: number[] = [];
  const bodies: any[] = [];

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };

  try {
    for (let i = 0; i < times; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      statuses.push(res.status);
      bodies.push(await res.json().catch(() => null));
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  return { statuses, bodies };
}

function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post("/x", limiter, (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

describe("credential rate limiting", () => {
  it("trips once the per-(ip, email) budget is spent, with a stable error contract", async () => {
    // limit 2, so the third identical attempt is the one that must be refused.
    const app = appWith(credentialLimit("test-login", "email", 2, "Too many sign-in attempts."));

    const { statuses, bodies } = await hit(app, "/x", { email: "a@test.local" }, 3);

    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses[2]).toBe(429);
    expect(bodies[2]).toEqual({
      error: "Too many sign-in attempts.",
      code: "RATE_LIMITED",
    });
  });

  it("gives each email its own budget so one account cannot be locked out", async () => {
    const app = appWith(credentialLimit("test-login2", "email", 2, "Slow down."));

    const first = await hit(app, "/x", { email: "a@test.local" }, 3);
    expect(first.statuses).toContain(429);

    // A different address from the same IP is unaffected.
    const second = await hit(app, "/x", { email: "b@test.local" }, 2);
    expect(second.statuses).toEqual([200, 200]);
  });

  it("treats email casing and padding as the same key", async () => {
    const app = appWith(credentialLimit("test-login3", "email", 2, "Slow down."));

    await hit(app, "/x", { email: "c@test.local" }, 2);
    const padded = await hit(app, "/x", { email: "  C@Test.Local  " }, 1);

    // Same normalised key, so the budget is already spent.
    expect(padded.statuses).toEqual([429]);
  });

  it("falls back to the IP alone when no email is present in the body", async () => {
    const app = appWith(credentialLimit("test-login4", "email", 2, "Slow down."));

    const { statuses } = await hit(app, "/x", {}, 3);
    expect(statuses[2]).toBe(429);
  });
});

describe("production limiters are exported", () => {
  it("has a handler for each credential endpoint", () => {
    expect(typeof loginLimiter).toBe("function");
    expect(typeof resetLimiter).toBe("function");
    expect(typeof otpVerifyLimiter).toBe("function");
  });
});