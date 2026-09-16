const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");

async function migrate() {
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(sql);
  console.log("Schema applied.");
}

migrate()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
