const db = require("../db");
const { encrypt, decrypt, emailBlindIndex } = require("../lib/pii");
const { hashPassword, verifyPassword, generateSessionToken, hashToken, validatePasswordStrength, MAX_PASSWORD_LENGTH } = require("../lib/auth");
const { setSessionCookie, clearSessionCookie, PERSON_SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } = require("../lib/cookies");
const { recentFailures, WINDOW_MINUTES, MAX_FAILS_PER_EMAIL, MAX_FAILS_PER_IP } = require("./auth");
const { certificationById, vendorBySlug } = require("../lib/certifications");
const { startOsintInBackground, verifyClaimAndSave, latestRun, loadPerson } = require("../lib/osint");
const { USERNAME_RE } = require("../lib/osint/sherlock");

// Учётные записи проходящих проверку — кандидатов на вакансию и сотрудников.
// Та же модель, что у ревьюеров (routes/auth.js): scrypt-хэш пароля,
// httpOnly-кука со случайным токеном, на сервере — только sha256 токена,
// блокировка перебора через login_attempts (ключ 'person-email:...').

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;
const DUMMY_HASH = hashPassword("dummy-password-for-timing-equalization");
const OSINT_RERUN_COOLDOWN_MINUTES = 5;

function normalizePhone(phone) {
  return String(phone).trim().replace(/[\s()-]/g, "");
}

async function resolvePersonFromSession(req) {
  const token = req.cookies && req.cookies[PERSON_SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT p.* FROM person_sessions s JOIN people p ON p.id = s.person_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function requirePerson(req, res) {
  const person = await resolvePersonFromSession(req);
  if (!person) {
    res.status(401).json({ error: "Требуется вход в личный кабинет" });
    return null;
  }
  return person;
}

async function createSession(res, personId) {
  await db.query("DELETE FROM person_sessions WHERE expires_at < now()");
  const token = generateSessionToken();
  await db.query("INSERT INTO person_sessions (person_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
    personId,
    hashToken(token),
    new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
  ]);
  setSessionCookie(res, token, PERSON_SESSION_COOKIE);
}

function certificateView(c) {
  const catalog = c.catalog_id ? certificationById.get(c.catalog_id) : null;
  const vendor = catalog ? vendorBySlug.get(catalog.vendor) : null;
  return {
    id: c.id,
    source: c.source,
    catalogId: c.catalog_id,
    vendor: c.vendor,
    name: c.name,
    credentialId: c.credential_id,
    url: c.url,
    issuedOn: c.issued_on,
    expiresOn: c.expires_on,
    status: c.status,
    statusDetail: c.status_detail,
    reviewed: Boolean(c.reviewed_by),
    checkedAt: c.checked_at,
    topics: catalog ? catalog.topics : [],
    verifyUrl: vendor ? vendor.verify.url : null,
  };
}

function osintView(run) {
  if (!run) return null;
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    usernames: run.usernames || [],
    sherlockAvailable: run.sherlock_available,
    profiles: run.profiles || [],
    credly: run.credly || [],
    error: run.error,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };
}

async function listCertificates(personId) {
  const { rows } = await db.query(
    "SELECT * FROM certificates WHERE person_id = $1 ORDER BY (status = 'verified') DESC, source, created_at",
    [personId]
  );
  return rows.map(certificateView);
}

// POST /api/people/register
// body: { fullName, email, phone, password, context, organizationName?, osintUsername?, osintConsent }
async function register(req, res) {
  const { fullName, email, phone, password, context, organizationName, osintUsername, osintConsent } = req.body || {};
  const problems = [];
  if (!fullName || typeof fullName !== "string" || !fullName.trim()) problems.push("ФИО обязательно");
  if (!email || typeof email !== "string" || !EMAIL_RE.test(email.trim())) problems.push("некорректный email");
  if (!phone || typeof phone !== "string" || !PHONE_RE.test(phone.trim())) problems.push("некорректный номер телефона");
  if (!["employee", "candidate"].includes(context)) problems.push("context должен быть employee | candidate");
  if (osintUsername && (typeof osintUsername !== "string" || !USERNAME_RE.test(osintUsername.trim()))) {
    problems.push("никнейм: 2–40 символов, латиница, цифры, точка, дефис, подчёркивание");
  }
  if (osintConsent !== true) problems.push("нужно согласие на проверку публичных профилей и сертификатов");
  const weakness = validatePasswordStrength(password);
  if (weakness) problems.push(weakness.toLowerCase());
  if (problems.length) {
    res.status(400).json({ error: problems.join("; ") });
    return;
  }

  const emailHash = emailBlindIndex(email);
  const existing = await db.query("SELECT id FROM people WHERE email_hash = $1", [emailHash]);
  if (existing.rows[0]) {
    res.status(409).json({ error: "Этот email уже зарегистрирован — войдите в личный кабинет" });
    return;
  }

  const personId = await db.transaction(async (client) => {
    let organizationId = null;
    if (organizationName && context === "employee") {
      const org = await client.query("SELECT id FROM organizations WHERE name = $1", [organizationName.trim()]);
      organizationId = org.rows[0]
        ? org.rows[0].id
        : (await client.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [organizationName.trim()])).rows[0].id;
    }
    const inserted = await client.query(
      `INSERT INTO people (full_name, email, email_hash, phone, osint_username, password_hash, context, organization_id, osint_consent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
      [
        encrypt(fullName.trim()),
        encrypt(email.trim()),
        emailHash,
        encrypt(normalizePhone(phone)),
        osintUsername ? encrypt(osintUsername.trim()) : null,
        hashPassword(password),
        context,
        organizationId,
      ]
    );
    return inserted.rows[0].id;
  });

  await createSession(res, personId);
  startOsintInBackground(personId, { trigger: "registration" });
  res.status(201).json({ id: personId, fullName: fullName.trim(), email: email.trim(), context });
}

// POST /api/people/login  body: { email, password }
async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password || typeof email !== "string" || typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: "email и пароль обязательны" });
    return;
  }
  const emailKey = `person-email:${email.trim().toLowerCase()}`;
  const ipKey = `ip:${req.ip}`;
  const [emailFails, ipFails] = await Promise.all([recentFailures(emailKey), recentFailures(ipKey)]);
  if (emailFails >= MAX_FAILS_PER_EMAIL || ipFails >= MAX_FAILS_PER_IP) {
    res.set("Retry-After", String(WINDOW_MINUTES * 60));
    res.status(429).json({ error: `Слишком много неудачных попыток входа. Повторите через ${WINDOW_MINUTES} минут.` });
    return;
  }

  const { rows } = await db.query("SELECT id, password_hash, context FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
  const person = rows[0];
  const ok = verifyPassword(password, person && person.password_hash ? person.password_hash : DUMMY_HASH) && Boolean(person && person.password_hash);
  if (!ok) {
    await db.query("INSERT INTO login_attempts (key) VALUES ($1), ($2)", [emailKey, ipKey]);
    res.status(401).json({ error: "Неверный email или пароль" });
    return;
  }
  await db.query("DELETE FROM login_attempts WHERE key = $1", [emailKey]);
  await createSession(res, person.id);
  res.json({ id: person.id, context: person.context });
}

// POST /api/people/logout
async function logout(req, res) {
  const token = req.cookies && req.cookies[PERSON_SESSION_COOKIE];
  if (token) await db.query("DELETE FROM person_sessions WHERE token_hash = $1", [hashToken(token)]);
  clearSessionCookie(res, PERSON_SESSION_COOKIE);
  res.json({ ok: true });
}

// GET /api/people/me — профиль, сертификаты, последний OSINT-запуск, проверки.
async function me(req, res) {
  const person = await requirePerson(req, res);
  if (!person) return;
  const [certificates, run, assessments, org] = await Promise.all([
    listCertificates(person.id),
    latestRun(person.id),
    db.query(
      `SELECT a.id, a.status, a.created_at, s.code AS standard_code, s.title AS standard_title
       FROM assessments a JOIN standards s ON s.id = a.standard_id
       WHERE a.person_id = $1 ORDER BY a.created_at DESC`,
      [person.id]
    ),
    person.organization_id ? db.query("SELECT name FROM organizations WHERE id = $1", [person.organization_id]) : null,
  ]);
  res.json({
    id: person.id,
    fullName: decrypt(person.full_name),
    email: decrypt(person.email),
    phone: person.phone ? decrypt(person.phone) : null,
    osintUsername: person.osint_username ? decrypt(person.osint_username) : null,
    context: person.context,
    organizationName: org && org.rows[0] ? org.rows[0].name : null,
    certificates,
    osint: osintView(run),
    assessments: assessments.rows,
  });
}

// PATCH /api/people/me  body: { phone?, osintUsername? } — смена никнейма
// перезапускает OSINT.
async function updateProfile(req, res) {
  const person = await requirePerson(req, res);
  if (!person) return;
  const { phone, osintUsername } = req.body || {};
  const updates = [];
  const args = [];
  if (phone !== undefined) {
    if (typeof phone !== "string" || !PHONE_RE.test(phone.trim())) {
      res.status(400).json({ error: "некорректный номер телефона" });
      return;
    }
    args.push(encrypt(normalizePhone(phone)));
    updates.push(`phone = $${args.length}`);
  }
  let usernameChanged = false;
  if (osintUsername !== undefined) {
    const value = osintUsername === null || osintUsername === "" ? null : String(osintUsername).trim();
    if (value && !USERNAME_RE.test(value)) {
      res.status(400).json({ error: "никнейм: 2–40 символов, латиница, цифры, точка, дефис, подчёркивание" });
      return;
    }
    const current = person.osint_username ? decrypt(person.osint_username) : null;
    usernameChanged = current !== value;
    args.push(value ? encrypt(value) : null);
    updates.push(`osint_username = $${args.length}`);
  }
  if (!updates.length) {
    res.status(400).json({ error: "нечего обновлять: phone и/или osintUsername" });
    return;
  }
  args.push(person.id);
  await db.query(`UPDATE people SET ${updates.join(", ")} WHERE id = $${args.length}`, args);
  if (usernameChanged) startOsintInBackground(person.id, { trigger: "profile_update" });
  res.json({ ok: true, osintRestarted: usernameChanged });
}

// POST /api/people/me/certificates
// body: { catalogId? | (vendor + name), credentialId?, url?, issuedOn? }
async function addCertificate(req, res) {
  const person = await requirePerson(req, res);
  if (!person) return;
  const { catalogId, vendor, name, credentialId, url, issuedOn } = req.body || {};
  const catalog = catalogId ? certificationById.get(catalogId) : null;
  if (catalogId && !catalog) {
    res.status(400).json({ error: "Неизвестный сертификат каталога" });
    return;
  }
  if (!catalog && (!vendor || !name)) {
    res.status(400).json({ error: "Укажите сертификат из каталога или вендора и название" });
    return;
  }
  if (url && (typeof url !== "string" || !/^https:\/\/[^\s]+$/i.test(url) || url.length > 500)) {
    res.status(400).json({ error: "Ссылка должна начинаться с https://" });
    return;
  }
  if (issuedOn && !/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) {
    res.status(400).json({ error: "issuedOn — дата в формате ГГГГ-ММ-ДД" });
    return;
  }
  const { rows } = await db.query(
    `INSERT INTO certificates (person_id, source, catalog_id, vendor, name, credential_id, url, issued_on)
     VALUES ($1, 'candidate', $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      person.id,
      catalog ? catalog.id : null,
      catalog ? catalog.vendorTitle : String(vendor).trim().slice(0, 100),
      catalog ? catalog.name : String(name).trim().slice(0, 200),
      credentialId ? String(credentialId).trim().slice(0, 100) : null,
      url || null,
      issuedOn || null,
    ]
  );
  const certId = rows[0].id;
  // Проверка ссылки на бейдж — один запрос к Credly, ограничен таймаутом.
  await verifyClaimAndSave(certId, await loadPerson(person.id));
  const saved = await db.query("SELECT * FROM certificates WHERE id = $1", [certId]);
  res.status(201).json(certificateView(saved.rows[0]));
}

// DELETE /api/people/me/certificates/:certId — только свои заявленные (не найденные OSINT).
async function deleteCertificate(req, res) {
  const person = await requirePerson(req, res);
  if (!person) return;
  const { rowCount } = await db.query(
    "DELETE FROM certificates WHERE id = $1 AND person_id = $2 AND source = 'candidate'",
    [Number(req.params.certId), person.id]
  );
  if (!rowCount) {
    res.status(404).json({ error: "Сертификат не найден" });
    return;
  }
  res.json({ ok: true });
}

// POST /api/people/me/osint — перезапуск поиска самим кандидатом (не чаще
// раза в OSINT_RERUN_COOLDOWN_MINUTES — каждый запуск дёргает внешние сайты).
async function rerunOsint(req, res) {
  const person = await requirePerson(req, res);
  if (!person) return;
  const recent = await db.query(
    `SELECT 1 FROM osint_runs WHERE person_id = $1
     AND (status = 'running' OR started_at > now() - make_interval(mins => $2)) LIMIT 1`,
    [person.id, OSINT_RERUN_COOLDOWN_MINUTES]
  );
  if (recent.rows[0]) {
    res.status(429).json({ error: `Поиск уже идёт или запускался менее ${OSINT_RERUN_COOLDOWN_MINUTES} минут назад` });
    return;
  }
  startOsintInBackground(person.id, { trigger: "candidate" });
  res.status(202).json({ ok: true });
}

module.exports = {
  register,
  login,
  logout,
  me,
  updateProfile,
  addCertificate,
  deleteCertificate,
  rerunOsint,
  resolvePersonFromSession,
  requirePerson,
  certificateView,
  osintView,
  listCertificates,
};
