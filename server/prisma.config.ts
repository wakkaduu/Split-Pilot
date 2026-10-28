import { defineConfig } from "prisma/config";

// Prisma 7 reads the connection string here rather than in schema.prisma.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.DATABASE_URL ?? "file:./prisma/dev.db" },
});
