const { Pool } = require("pg");

// 152-ФЗ ст. 18.5 требует физического размещения ПДн на серверах в РФ —
// эта строка подключения указывает на локальный dev-инстанс и должна
// быть заменена на боевую РФ-инфраструктуру перед реальным запуском.
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://hr_poc_app:hr_poc_app_dev@localhost:5432/hr_poc",
});

function query(text, params) {
  return pool.query(text, params);
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, transaction, pool };
