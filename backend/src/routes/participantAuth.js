const db = require("../db");
const { hashPassword, verifyPassword, generateSessionToken, hashToken, validatePasswordStrength, MAX_PASSWORD_LENGTH } = require("../lib/auth");
const { setSessionCookie, clearSessionCookie, PARTICIPANT_SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } = require("../lib/cookies");
const { throttleKeys, rejectIfLockedOut, recordFailure, clearFailures } = require("../lib/loginThrottle");
const { encrypt, decrypt, emailBlindIndex } = require("../lib/pii");

// Аккаунты участников — кандидатов и сотрудников, проходящих проверку.
// Регистрация открытая (в отличие от ревьюеров, которых заводит
// администратор): участник сам создаёт аккаунт, входит и видит только свои
// проверки. ФИО/email хранятся зашифрованными (src/lib/pii.js), поиск по
// email — через email_hash.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LENGTH = 200;

// См. routes/auth.js: scrypt считается и для неизвестного email, чтобы по
// времени ответа нельзя было понять, есть ли такой аккаунт.
const DUMMY_HASH = hashPassword("dummy-password-for-timing-equalization");

async function participantView(person) {
  let organizationName = null;
  if (person.organization_id) {
    const { rows } = await db.query("SELECT name FROM organizations WHERE id = $1", [person.organization_id]);
    organizationName = rows[0] ? rows[0].name : null;
  }
  return {
    id: person.id,
    fullName: decrypt(person.full_name),
    email: decrypt(person.email),
    context: person.context,
    organizationName,
  };
}

async function resolveParticipantFromSession(req) {
  const token = req.cookies && req.cookies[PARTICIPANT_SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT p.* FROM participant_sessions s
     JOIN people p ON p.id = s.person_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function startSession(res, personId, client = db) {
  await client.query("DELETE FROM participant_sessions WHERE expires_at < now()");
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await client.query("INSERT INTO participant_sessions (person_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
    personId,
    hashToken(token),
    expiresAt,
  ]);
  setSessionCookie(res, token, PARTICIPANT_SESSION_COOKIE);
}

function isShortString(v) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_FIELD_LENGTH;
}

// POST /api/participant/register
// body: { fullName, email, password, context: 'employee'|'candidate', organizationName? }
async function register(req, res) {
  const { fullName, email, password, context, organizationName } = req.body || {};
  if (!isShortString(fullName) || !isShortString(email) || typeof password !== "string") {
    res.status(400).json({ error: "fullName, email и password обязательны" });
    return;
  }
  if (!EMAIL_RE.test(email.trim())) {
    res.status(400).json({ error: "Некорректный email" });
    return;
  }
  if (!["employee", "candidate"].includes(context)) {
    res.status(400).json({ error: "context должен быть employee | candidate" });
    return;
  }
  if (organizationName !== undefined && organizationName !== null && organizationName !== "" && !isShortString(organizationName)) {
    res.status(400).json({ error: "Некорректное название организации" });
    return;
  }
  const weakness = validatePasswordStrength(password);
  if (weakness) {
    res.status(400).json({ error: weakness });
    return;
  }

  const emailHash = emailBlindIndex(email);
  const person = await db.transaction(async (client) => {
    const existing = await client.query("SELECT id FROM people WHERE email_hash = $1", [emailHash]);
    if (existing.rows[0]) return null;

    let organizationId = null;
    const orgName = context === "employee" && organizationName ? organizationName.trim() : null;
    if (orgName) {
      const orgResult = await client.query("SELECT id FROM organizations WHERE name = $1", [orgName]);
      organizationId = orgResult.rows[0]
        ? orgResult.rows[0].id
        : (await client.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [orgName])).rows[0].id;
    }
    const inserted = await client.query(
      `INSERT INTO people (full_name, email, email_hash, context, organization_id, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [encrypt(fullName.trim()), encrypt(email.trim()), emailHash, context, organizationId, hashPassword(password)]
    );
    await startSession(res, inserted.rows[0].id, client);
    return inserted.rows[0];
  });

  if (!person) {
    // Сброса пароля по email нет (нет почтовой инфраструктуры) — забытый
    // пароль или запись, созданную до появления аккаунтов, администратор
    // восстанавливает через `node src/set-participant-password.js`.
    res.status(409).json({ error: "Аккаунт с таким email уже существует — войдите или обратитесь к администратору" });
    return;
  }
  res.status(201).json(await participantView(person));
}

// POST /api/participant/login  body: { email, password }
async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== "string" || typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: "email и пароль обязательны" });
    return;
  }
  const keys = throttleKeys("participant-email:", email, req.ip);
  if (await rejectIfLockedOut(res, keys)) return;

  const { rows } = await db.query("SELECT * FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
  const person = rows[0];
  const ok = verifyPassword(password, person && person.password_hash ? person.password_hash : DUMMY_HASH) && Boolean(person && person.password_hash);
  if (!ok) {
    await recordFailure(keys);
    res.status(401).json({ error: "Неверный email или пароль" });
    return;
  }

  await clearFailures(keys);
  await startSession(res, person.id);
  res.json(await participantView(person));
}

// POST /api/participant/logout
async function logout(req, res) {
  const token = req.cookies && req.cookies[PARTICIPANT_SESSION_COOKIE];
  if (token) await db.query("DELETE FROM participant_sessions WHERE token_hash = $1", [hashToken(token)]);
  clearSessionCookie(res, PARTICIPANT_SESSION_COOKIE);
  res.json({ ok: true });
}

// GET /api/participant/me
async function me(req, res) {
  const person = await resolveParticipantFromSession(req);
  if (!person) {
    res.status(401).json({ error: "Не авторизован" });
    return;
  }
  res.json(await participantView(person));
}

// POST /api/participant/change-password  body: { currentPassword, newPassword }
// Остальные сессии участника при этом отзываются.
async function changePassword(req, res) {
  const person = await resolveParticipantFromSession(req);
  if (!person) {
    res.status(401).json({ error: "Не авторизован" });
    return;
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "currentPassword и newPassword обязательны" });
    return;
  }
  if (!verifyPassword(currentPassword, person.password_hash)) {
    res.status(403).json({ error: "Текущий пароль указан неверно" });
    return;
  }
  const weakness = validatePasswordStrength(newPassword);
  if (weakness) {
    res.status(400).json({ error: weakness });
    return;
  }
  const currentToken = req.cookies[PARTICIPANT_SESSION_COOKIE];
  await db.transaction(async (client) => {
    await client.query("UPDATE people SET password_hash = $1 WHERE id = $2", [hashPassword(newPassword), person.id]);
    await client.query("DELETE FROM participant_sessions WHERE person_id = $1 AND token_hash <> $2", [person.id, hashToken(currentToken)]);
  });
  res.json({ ok: true });
}

// GET /api/participant/assessments — свои проверки (для «Мои проверки» и
// продолжения незавершённой). Баллы не отдаём: их видит ревьюер.
async function listOwnAssessments(req, res) {
  const person = await resolveParticipantFromSession(req);
  if (!person) {
    res.status(401).json({ error: "Не авторизован" });
    return;
  }
  const { rows } = await db.query(
    `SELECT a.id, a.status, a.context, a.created_at, s.code AS standard_code, s.title AS standard_title
     FROM assessments a JOIN standards s ON s.id = a.standard_id
     WHERE a.person_id = $1
     ORDER BY a.created_at DESC, a.id DESC`,
    [person.id]
  );
  res.json(rows);
}

module.exports = { register, login, logout, me, changePassword, listOwnAssessments, resolveParticipantFromSession };
