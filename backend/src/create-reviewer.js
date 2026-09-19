// Административный CLI для создания/обновления учётки ревьюера — нет
// формы саморегистрации, это осознанно (см. backend/README.md).
const { query, pool } = require("./db");
const { hashPassword } = require("./lib/auth");

async function main() {
  const [, , fullName, email, password, role] = process.argv;
  if (!fullName || !email || !password) {
    console.error('Использование: node src/create-reviewer.js "Имя Фамилия" email@example.ru пароль [role]');
    process.exitCode = 1;
    return;
  }

  const passwordHash = hashPassword(password);
  const existing = await query("SELECT id FROM reviewers WHERE email = $1", [email]);
  if (existing.rows[0]) {
    await query("UPDATE reviewers SET full_name = $1, password_hash = $2, role = $3 WHERE id = $4", [
      fullName,
      passwordHash,
      role || "reviewer",
      existing.rows[0].id,
    ]);
    console.log(`Обновлён существующий ревьюер: ${email}`);
  } else {
    await query("INSERT INTO reviewers (full_name, email, role, password_hash) VALUES ($1, $2, $3, $4)", [
      fullName,
      email,
      role || "reviewer",
      passwordHash,
    ]);
    console.log(`Создан ревьюер: ${email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
