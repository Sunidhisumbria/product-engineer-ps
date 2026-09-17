import { readFile } from "node:fs/promises";
import postgres from "postgres";

export type Sql = postgres.Sql;

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    transform: { column: { from: postgres.toCamel } },
    onnotice: () => {},
  });
}

const schemaUrl = new URL("../db/schema.sql", import.meta.url);

export async function migrate(sql: Sql): Promise<void> {
  const schema = await readFile(schemaUrl, "utf8");
  await sql.unsafe(schema);
}
