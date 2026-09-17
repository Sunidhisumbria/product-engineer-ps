import { afterAll, beforeEach } from "vitest";
import type { Clock } from "../src/clock";
import { createSql } from "../src/db";

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://webhooks:webhooks@localhost:5433/webhooks_test";

export function useTestDatabase() {
  const sql = createSql(testDatabaseUrl);

  beforeEach(async () => {
    await sql`TRUNCATE delivery_attempts, events`;
  });

  afterAll(async () => {
    await sql.end();
  });

  return sql;
}

export class FakeClock implements Clock {
  private current: Date;

  constructor(start = "2026-09-15T10:00:00.000Z") {
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
