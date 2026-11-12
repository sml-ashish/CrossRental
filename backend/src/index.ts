import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env";
import { prisma } from "./lib/database";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiLimiter } from "./middleware/rateLimiter";
import { seedSettings } from "./utils/settings";
import authRoutes from "./routes/auth.routes";
import vendorRoutes from "./routes/vendor.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import craneRoutes from "./routes/crane.routes";
import rfqRoutes from "./routes/rfq.routes";
import enquiryRoutes from "./routes/enquiry.routes";
import settingsRoutes from "./routes/settings.routes";
import reservationsRoutes from "./routes/reservations.routes";
import discoveryRoutes from "./routes/discovery.routes";
import communicationRoutes from "./routes/communication.routes";
import vendorQuotationRoutes from "./routes/vendorQuotation.routes";
import vendorDashboardRoutes from "./routes/vendorDashboard.routes";
import adminRoutes from "./routes/admin.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import managementRoutes from "./routes/management.routes";
import reportRoutes from "./routes/report.routes";
import whatsappRoutes from "./routes/whatsapp.routes";
import { startScheduler, stopScheduler } from "./job/scheduler";
import { registerDefaultJobs } from "./job/registerJobs";

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);

  app.use(
    helmet({
      // The portal is served separately from the API; the default CSP would
      // block the inline styles the email-preview surface uses.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );

  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: false, // Auth is a bearer token, never a cookie.
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // The WhatsApp webhook needs the exact bytes Meta signed. Mount it before
  // the JSON parser, which would otherwise consume and re-serialise the body.
  app.use("/api/whatsapp", whatsappRoutes);

  // Uploads go through multer's memory storage, but RFQ forms can carry a
  // base64 attachment fallback, so the JSON limit is generous.
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  app.use(requestLogger);

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      env: env.nodeEnv,
      time: new Date().toISOString(),
    });
  });

  app.use("/api", apiLimiter);

  app.use("/api/auth", authRoutes);
  app.use("/api/vendors", vendorRoutes);
  app.use("/api/onboarding", onboardingRoutes);
  app.use("/api/cranes", craneRoutes);
  app.use("/api/rfqs", rfqRoutes);
  app.use("/api/enquiries", enquiryRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/reservations", reservationsRoutes);
  app.use("/api/discovery", discoveryRoutes);
  app.use("/api/communications", communicationRoutes);
  app.use("/api/vendor/rfqs", vendorQuotationRoutes);
  app.use("/api/vendor/dashboard", vendorDashboardRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/management", managementRoutes);
  app.use("/api/reports", reportRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function main() {
  // Make sure the configurable thresholds exist before the first request that
  // reads them.
  await seedSettings();

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(
      `[server] listening on http://localhost:${env.port} (${env.nodeEnv})`,
    );
    console.log(
      `[server] geo provider: ${env.geo.provider}, storage: ${env.storage.driver}`,
    );
  });

  registerDefaultJobs();
  startScheduler();

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    stopScheduler();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[server] failed to start", err);
    process.exit(1);
  });
}
