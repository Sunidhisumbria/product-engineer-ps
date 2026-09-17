import { createSql, migrate } from "../src/db";
import { testDatabaseUrl } from "./helpers";

export async function setup() {
  const url = new URL(testDatabaseUrl);
  const databaseName = url.pathname.slice(1);
  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = "/postgres";

  const admin = createSql(adminUrl.toString());
  try {
    const [existing] = await admin`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
    if (!existing) await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const sql = createSql(testDatabaseUrl);
  try {
    await migrate(sql);
  } finally {
    await sql.end();
  }
}
