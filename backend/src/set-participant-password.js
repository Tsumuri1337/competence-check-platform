// Административный CLI: сброс забытого пароля участника (кандидат/сотрудник)
// или выдача пароля записи, созданной до появления аккаунтов участников.
// Сброса по email нет — в проекте нет почтовой инфраструктуры.
const { query, pool } = require("./db");
const { hashPassword, validatePasswordStrength } = require("./lib/auth");
const { emailBlindIndex } = require("./lib/pii");

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error("Использование: node src/set-participant-password.js email@example.ru пароль");
    process.exitCode = 1;
    return;
  }
  const weakness = validatePasswordStrength(password);
  if (weakness) {
    console.error(weakness);
    process.exitCode = 1;
    return;
  }

  const { rows } = await query("SELECT id FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
  if (!rows[0]) {
    console.error(`Участник с email ${email} не найден — он может зарегистрироваться сам на странице проверки.`);
    process.exitCode = 1;
    return;
  }
  const id = rows[0].id;
  await query("UPDATE people SET password_hash = $1 WHERE id = $2", [hashPassword(password), id]);
  const revoked = await query("DELETE FROM participant_sessions WHERE person_id = $1", [id]);
  await query("DELETE FROM login_attempts WHERE key = $1", [`participant-email:${email.trim().toLowerCase()}`]);
  console.log(`Пароль участника ${email} обновлён (отозвано сессий: ${revoked.rowCount}, блокировка входа снята)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
