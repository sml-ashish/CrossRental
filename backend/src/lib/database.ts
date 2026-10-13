import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { env } from "../config/env";

/**
 * Single Prisma client for the process. Prisma 7 talks to Postgres through a
 * driver adapter (the same @prisma/adapter-pg setup the CustomerPulse backend
 * uses), so the connection string is supplied here rather than in the schema.
 */
const adapter = new PrismaPg({ connectionString: env.databaseUrl });

export const prisma = new PrismaClient({ adapter });

export type Tx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;