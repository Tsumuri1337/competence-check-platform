const db = require("../db");
const { verifyPassword, generateSessionToken, hashToken } = require("../lib/auth");
const { setSessionCookie, clearSessionCookie, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } = require("../lib/cookies");

function reviewerView(r) {
  return { id: r.id, fullName: r.full_name, email: r.email, role: r.role };
}

// Достаёт ревьюера по сессионной куке текущего запроса — используется в
// routes/reviewers.js вместо прежней заглушки через X-Reviewer-Email.
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
  if (!email || !password) {
    res.status(400).json({ error: "email и пароль обязательны" });
    return;
  }

  const { rows } = await db.query("SELECT * FROM reviewers WHERE email = $1", [email]);
  const reviewer = rows[0];
  if (!reviewer || !verifyPassword(password, reviewer.password_hash)) {
    res.status(401).json({ error: "Неверный email или пароль" });
    return;
  }

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

module.exports = { login, logout, me, resolveReviewerFromSession };
