import { loadConfig } from "../src/config";
import { createSql, migrate } from "../src/db";

const config = loadConfig();
const sql = createSql(config.databaseUrl);

try {
  await migrate(sql);
  console.log("Schema applied.");
} finally {
  await sql.end();
}
