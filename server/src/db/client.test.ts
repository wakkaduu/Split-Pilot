import { afterAll, expect, it } from "vitest";
import { createPrisma } from "./client.ts";

// In-memory SQLite: proves the adapter, the generated client, and the schema's
// relations work together without touching a file.
const prisma = createPrisma("file::memory:");
afterAll(() => prisma.$disconnect());

it("creates the tables from the schema and stores an expense with shares", async () => {
  // `prisma db push` is how real databases are created; for the in-memory proof
  // we create the tables from the migration SQL Prisma would generate.
  const { execFileSync } = await import("node:child_process");
  const sql = execFileSync("npx", ["prisma", "migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"], { encoding: "utf8" });
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(stmt);

  const group = await prisma.group.create({ data: { name: "Cabin", currency: "USD" } });
  const [alex, sam] = await Promise.all([
    prisma.member.create({ data: { groupId: group.id, name: "Alex" } }),
    prisma.member.create({ data: { groupId: group.id, name: "Sam" } }),
  ]);
  const expense = await prisma.expense.create({
    data: {
      groupId: group.id, description: "Groceries", totalAmount: 5001, currency: "USD", payerId: alex.id,
      shares: { create: [{ memberId: alex.id, allocatedAmount: 2501 }, { memberId: sam.id, allocatedAmount: 2500 }] },
    },
    include: { shares: true },
  });
  expect(expense.shares.reduce((s, x) => s + x.allocatedAmount, 0)).toBe(expense.totalAmount);
  await expect(prisma.member.create({ data: { groupId: group.id, name: "Sam" } })).rejects.toThrow();
});
