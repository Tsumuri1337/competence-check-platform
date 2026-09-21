const db = require("../db");
const { hashPassword, verifyPassword, generateSessionToken, hashToken, validatePasswordStrength, MAX_PASSWORD_LENGTH } = require("../lib/auth");
const { setSessionCookie, clearSessionCookie, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } = require("../lib/cookies");

// Блокировка перебора пароля: после стольких неудач за окно вход по этому
// email (или с этого IP) отвечает 429. Ключ по email считается и для
// несуществующих адресов, чтобы блокировка не выдавала, есть ли такой ревьюер.
const WINDOW_MINUTES = 15;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 30;

// Хэш для сравнения, когда ревьюера с таким email нет: без этого ответ на
// неизвестный email заметно быстрее (scrypt не считается) и по времени видно,
// какие адреса существуют.
const DUMMY_HASH = hashPassword("dummy-password-for-timing-equalization");

function reviewerView(r) {
  return { id: r.id, fullName: r.full_name, email: r.email, role: r.role };
}

// Достаёт ревьюера по сессионной куке текущего запроса — используется в
// routes/reviewers.js.
async function resolveReviewerFromSession(req) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT r.* FROM reviewer_sessions s
     JOIN reviewers r ON r.id = s.reviewer_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function recentFailures(key) {
  const { rows } = await db.query(
    `SELECT count(*) FROM login_attempts WHERE key = $1 AND at > now() - make_interval(mins => $2)`,
    [key, WINDOW_MINUTES]
  );
  return Number(rows[0].count);
}

// POST /api/auth/login  body: { email, password }
async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== "string" || typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: "email и пароль обязательны" });
    return;
  }

  const emailKey = `email:${email.trim().toLowerCase()}`;
  const ipKey = `ip:${req.ip}`;
  const [emailFails, ipFails] = await Promise.all([recentFailures(emailKey), recentFailures(ipKey)]);
  if (emailFails >= MAX_FAILS_PER_EMAIL || ipFails >= MAX_FAILS_PER_IP) {
    res.set("Retry-After", String(WINDOW_MINUTES * 60));
    res.status(429).json({ error: `Слишком много неудачных попыток входа. Повторите через ${WINDOW_MINUTES} минут.` });
    return;
  }

  const { rows } = await db.query("SELECT * FROM reviewers WHERE email = $1", [email.trim()]);
  const reviewer = rows[0];
  const ok = verifyPassword(password, reviewer ? reviewer.password_hash : DUMMY_HASH) && Boolean(reviewer);
  if (!ok) {
    await db.query("INSERT INTO login_attempts (key) VALUES ($1), ($2)", [emailKey, ipKey]);
    res.status(401).json({ error: "Неверный email или пароль" });
    return;
  }

  // Успешный вход сбрасывает счётчик по этому email; заодно чистим старые записи.
  await db.query("DELETE FROM login_attempts WHERE key = $1 OR at < now() - interval '1 day'", [emailKey]);
  await db.query("DELETE FROM reviewer_sessions WHERE expires_at < now()");

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await db.query(
    "INSERT INTO reviewer_sessions (reviewer_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [reviewer.id, hashToken(token), expiresAt]
  );
  setSessionCookie(res, token);
  res.json(reviewerView(reviewer));
}

// POST /api/auth/logout
async function logout(req, res) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) {
    await db.query("DELETE FROM reviewer_sessions WHERE token_hash = $1", [hashToken(token)]);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
}

// GET /api/auth/me
async function me(req, res) {
  const reviewer = await resolveReviewerFromSession(req);
  if (!reviewer) {
    res.status(401).json({ error: "Не авторизован" });
    return;
  }
  res.json(reviewerView(reviewer));
}

// POST /api/auth/change-password  body: { currentPassword, newPassword }
// Сброса пароля по email нет (в проекте нет почтовой инфраструктуры) — забытый
// пароль администратор меняет через `node src/create-reviewer.js`. Здесь —
// смена пароля самим вошедшим ревьюером; все его остальные сессии отзываются.
async function changePassword(req, res) {
  const reviewer = await resolveReviewerFromSession(req);
  if (!reviewer) {
    res.status(401).json({ error: "Не авторизован" });
    return;
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "currentPassword и newPassword обязательны" });
    return;
  }
  if (!verifyPassword(currentPassword, reviewer.password_hash)) {
    res.status(403).json({ error: "Текущий пароль указан неверно" });
    return;
  }
  const weakness = validatePasswordStrength(newPassword);
  if (weakness) {
    res.status(400).json({ error: weakness });
    return;
  }

  const currentToken = req.cookies[SESSION_COOKIE];
  await db.transaction(async (client) => {
    await client.query("UPDATE reviewers SET password_hash = $1 WHERE id = $2", [hashPassword(newPassword), reviewer.id]);
    await client.query("DELETE FROM reviewer_sessions WHERE reviewer_id = $1 AND token_hash <> $2", [
      reviewer.id,
      hashToken(currentToken),
    ]);
  });
  res.json({ ok: true });
}

module.exports = { login, logout, me, changePassword, resolveReviewerFromSession };
