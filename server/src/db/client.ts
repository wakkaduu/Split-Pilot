import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.ts";

/** Prisma 7 talks to SQLite through a driver adapter. `url` looks like "file:./prisma/dev.db". */
export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

export type { PrismaClient };
