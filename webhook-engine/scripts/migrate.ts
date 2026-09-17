import { loadConfig, loadDotEnv } from "../src/config";
import { createSql, migrate } from "../src/db";

loadDotEnv();
const config = loadConfig();
const sql = createSql(config.databaseUrl);

try {
  await migrate(sql);
  console.log("Schema applied.");
} finally {
  await sql.end();
}
