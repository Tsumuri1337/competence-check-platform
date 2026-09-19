const fs = require("fs");
const path = require("path");
const { pool } = require("./db");
const { encrypt, emailBlindIndex, isEncrypted } = require("./lib/pii");

const SCHEMA_PATH = path.join(__dirname, "schema.sql");

// Шифрует ПДн, записанные до появления шифрования (идемпотентно: уже
// зашифрованные строки пропускаются).
async function encryptExistingPeople() {
  const { rows } = await pool.query("SELECT id, full_name, email FROM people");
  let count = 0;
  for (const p of rows) {
    if (isEncrypted(p.email) && isEncrypted(p.full_name)) continue;
    const plainEmail = isEncrypted(p.email) ? null : p.email;
    await pool.query("UPDATE people SET full_name = $1, email = $2, email_hash = COALESCE($3, email_hash) WHERE id = $4", [
      isEncrypted(p.full_name) ? p.full_name : encrypt(p.full_name),
      isEncrypted(p.email) ? p.email : encrypt(p.email),
      plainEmail ? emailBlindIndex(plainEmail) : null,
      p.id,
    ]);
    count++;
  }
  if (count) console.log(`Зашифровано ПДн у ${count} записей people.`);
}

async function migrate() {
  const sql = fs.readFileSync(SCHEMA_PATH, "utf8");
  await pool.query(sql);
  await encryptExistingPeople();
  console.log("Schema applied.");
}

migrate()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
