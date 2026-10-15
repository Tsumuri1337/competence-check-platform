const db = require("../db");
const { hashPassword, verifyPassword, generateSessionToken, hashToken, validatePasswordStrength, MAX_PASSWORD_LENGTH } = require("../lib/auth");
const { setSessionCookie, clearSessionCookie, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } = require("../lib/cookies");
const { throttleKeys, rejectIfLockedOut, recordFailure, clearFailures } = require("../lib/loginThrottle");

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

// POST /api/auth/login  body: { email, password }
async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== "string" || typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: "email и пароль обязательны" });
    return;
  }

  const keys = throttleKeys("email:", email, req.ip);
  if (await rejectIfLockedOut(res, keys)) return;

  const { rows } = await db.query("SELECT * FROM reviewers WHERE email = $1", [email.trim()]);
  const reviewer = rows[0];
  const ok = verifyPassword(password, reviewer ? reviewer.password_hash : DUMMY_HASH) && Boolean(reviewer);
  if (!ok) {
    await recordFailure(keys);
    res.status(401).json({ error: "Неверный email или пароль" });
    return;
  }

  await clearFailures(keys);
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
