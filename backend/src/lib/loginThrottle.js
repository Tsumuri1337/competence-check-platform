const db = require("../db");

// Блокировка перебора пароля, общая для входа ревьюеров и участников: после
// стольких неудач за окно вход по этому email (или с этого IP) отвечает 429.
// Ключ по email считается и для несуществующих адресов, чтобы блокировка не
// выдавала, есть ли такой аккаунт. Счётчик в БД (login_attempts), а не в
// памяти процесса — переживает перезапуск и работает на нескольких инстансах.
const WINDOW_MINUTES = 15;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 30;

async function recentFailures(key) {
  const { rows } = await db.query(
    `SELECT count(*) FROM login_attempts WHERE key = $1 AND at > now() - make_interval(mins => $2)`,
    [key, WINDOW_MINUTES]
  );
  return Number(rows[0].count);
}

// prefix разделяет счётчики ревьюеров и участников: 'email:' / 'participant-email:'.
function throttleKeys(prefix, email, ip) {
  return { emailKey: `${prefix}${email.trim().toLowerCase()}`, ipKey: `ip:${ip}` };
}

// true — запрос заблокирован и ответ 429 уже отправлен.
async function rejectIfLockedOut(res, { emailKey, ipKey }) {
  const [emailFails, ipFails] = await Promise.all([recentFailures(emailKey), recentFailures(ipKey)]);
  if (emailFails >= MAX_FAILS_PER_EMAIL || ipFails >= MAX_FAILS_PER_IP) {
    res.set("Retry-After", String(WINDOW_MINUTES * 60));
    res.status(429).json({ error: `Слишком много неудачных попыток входа. Повторите через ${WINDOW_MINUTES} минут.` });
    return true;
  }
  return false;
}

async function recordFailure({ emailKey, ipKey }) {
  await db.query("INSERT INTO login_attempts (key) VALUES ($1), ($2)", [emailKey, ipKey]);
}

// Успешный вход сбрасывает счётчик по этому email; заодно чистим старые записи.
async function clearFailures({ emailKey }) {
  await db.query("DELETE FROM login_attempts WHERE key = $1 OR at < now() - interval '1 day'", [emailKey]);
}

module.exports = { throttleKeys, rejectIfLockedOut, recordFailure, clearFailures, WINDOW_MINUTES };
