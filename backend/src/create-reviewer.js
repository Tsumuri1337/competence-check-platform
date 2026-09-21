// Административный CLI: создание учётки ревьюера и сброс забытого пароля.
// Формы саморегистрации и сброса по email нет — осознанно (см. backend/README.md).
const { query, pool } = require("./db");
const { hashPassword, validatePasswordStrength } = require("./lib/auth");

async function main() {
  const [, , fullName, email, password, role] = process.argv;
  if (!fullName || !email || !password) {
    console.error('Использование: node src/create-reviewer.js "Имя Фамилия" email@example.ru пароль [role]');
    process.exitCode = 1;
    return;
  }
  const weakness = validatePasswordStrength(password);
  if (weakness) {
    console.error(weakness);
    process.exitCode = 1;
    return;
  }

  const passwordHash = hashPassword(password);
  const existing = await query("SELECT id FROM reviewers WHERE email = $1", [email]);
  if (existing.rows[0]) {
    const id = existing.rows[0].id;
    await query("UPDATE reviewers SET full_name = $1, password_hash = $2, role = $3 WHERE id = $4", [
      fullName,
      passwordHash,
      role || "reviewer",
      id,
    ]);
    // Пароль сменили — старые сессии (возможно, чужие) больше недействительны.
    const revoked = await query("DELETE FROM reviewer_sessions WHERE reviewer_id = $1", [id]);
    await query("DELETE FROM login_attempts WHERE key = $1", [`email:${email.trim().toLowerCase()}`]);
    console.log(`Обновлён существующий ревьюер: ${email} (отозвано сессий: ${revoked.rowCount}, блокировка входа снята)`);
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
