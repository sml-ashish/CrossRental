import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "ts-node src/lib/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    // Used by `prisma migrate diff --from-migrations` to replay the migration
    // history into a scratch database and compare it against the schema. It is
    // created and dropped automatically; it never holds real data.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});