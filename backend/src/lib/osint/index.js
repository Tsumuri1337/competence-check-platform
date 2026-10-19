const db = require("../../db");
const { decrypt } = require("../pii");
const { matchCatalog, certificationById, vendorBySlug } = require("../certifications");
const credly = require("./credly");
const { runSherlock, USERNAME_RE } = require("./sherlock");
const { namesMatch, nameSlugs } = require("./names");

// Оркестратор OSINT-проверки сертификатов кандидата:
//   1. Sherlock по никнеймам (указанный кандидатом + local-part email) —
//      находит профили на ИБ-платформах (HTB, THM, GitHub, Credly, ...).
//   2. Credly — по никнеймам и по vanity-адресу из ФИО (ivan-petrov):
//      бейджи профиля, принадлежность проверяется по хэшу email в Open
//      Badges assertion (сильная проверка) или по имени получателя (слабая).
//   3. Сверка заявленных кандидатом сертификатов с найденными бейджами и
//      проверка присланных ссылок на бейджи.
// Работает в фоне (не блокирует регистрацию) — результат пишется в
// osint_runs и certificates, страницы опрашивают статус.

function personUsernames(person) {
  const fromEmail = person.email.split("@")[0];
  return [...new Set([person.osintUsername, fromEmail].filter((u) => u && USERNAME_RE.test(u)))];
}

async function loadPerson(personId) {
  const { rows } = await db.query("SELECT id, full_name, email, osint_username FROM people WHERE id = $1", [personId]);
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    fullName: decrypt(rows[0].full_name),
    email: decrypt(rows[0].email),
    osintUsername: rows[0].osint_username ? decrypt(rows[0].osint_username) : null,
  };
}

// Статус бейджа относительно человека. explicit — профиль Credly указан
// кандидатом (его никнейм), а не угадан по ФИО.
async function classifyBadge(badge, person, explicit) {
  let assertion = null;
  try {
    assertion = await credly.fetchAssertion(badge.id);
  } catch (e) {
    /* assertion недоступен — решаем по имени */
  }
  if (assertion && credly.recipientMatchesEmail(assertion.recipient, person.email)) {
    return { status: "verified", detail: "Email получателя бейджа совпал с email кандидата (Open Badges, Credly)" };
  }
  if (badge.issuedTo && namesMatch(badge.issuedTo, person.fullName)) {
    return {
      status: "probable",
      detail: `Имя получателя «${badge.issuedTo}» совпадает с ФИО, но бейдж выдан на другой email — нужна ручная проверка`,
    };
  }
  if (!explicit) return null; // угаданный по ФИО профиль без совпадений — скорее однофамилец, не сохраняем
  return {
    status: "owner_mismatch",
    detail: badge.issuedTo ? `Бейдж выдан на имя «${badge.issuedTo}», не совпадает с ФИО кандидата` : "Не удалось подтвердить получателя",
  };
}

async function scanCredly(person, usernames) {
  const slugs = [...new Set([...usernames, ...nameSlugs(person.fullName)].map((s) => s.toLowerCase()))];
  const explicitSlugs = new Set(usernames.map((u) => u.toLowerCase()));
  const summary = [];
  const badges = [];
  for (const slug of slugs) {
    let profile;
    try {
      profile = await credly.fetchProfileBadges(slug);
    } catch (e) {
      summary.push({ slug, found: false, error: e.message });
      continue;
    }
    if (!profile) {
      summary.push({ slug, found: false });
      continue;
    }
    let kept = 0;
    for (const badge of profile) {
      const verdict = await classifyBadge(badge, person, explicitSlugs.has(slug));
      if (!verdict) continue;
      kept++;
      badges.push({ ...badge, ...verdict, catalog: matchCatalog(badge.name, badge.issuer) });
    }
    summary.push({ slug, found: true, badgeCount: profile.length, kept, explicit: explicitSlugs.has(slug) });
  }
  return { summary, badges };
}

async function saveCredlyBadges(personId, badges) {
  for (const b of badges) {
    // Решение ревьюера (reviewed_by) не перетираем повторным OSINT-запуском.
    await db.query(
      `INSERT INTO certificates (person_id, source, catalog_id, vendor, name, url, external_id, issued_on, expires_on, status, status_detail, checked_at)
       VALUES ($1, 'credly', $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (person_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         catalog_id = EXCLUDED.catalog_id, vendor = EXCLUDED.vendor, name = EXCLUDED.name, url = EXCLUDED.url,
         issued_on = EXCLUDED.issued_on, expires_on = EXCLUDED.expires_on, checked_at = now(),
         status = CASE WHEN certificates.reviewed_by IS NULL THEN EXCLUDED.status ELSE certificates.status END,
         status_detail = CASE WHEN certificates.reviewed_by IS NULL THEN EXCLUDED.status_detail ELSE certificates.status_detail END`,
      [
        personId,
        b.catalog ? b.catalog.id : null,
        b.catalog ? b.catalog.vendorTitle : b.issuer || "Credly",
        b.name,
        b.url,
        b.id,
        b.issuedOn,
        b.expiresOn,
        b.status,
        b.detail,
      ]
    );
  }
}

// Проверка одного заявленного кандидатом сертификата. Возвращает
// { status, detail } — вызывающий сохраняет.
async function verifyClaim(cert, person) {
  const badgeId = credly.parseBadgeUrl(cert.url);
  if (badgeId) {
    const assertion = await credly.fetchAssertion(badgeId);
    if (!assertion) return { status: "not_found", detail: "Бейдж по ссылке Credly не найден" };
    if (credly.recipientMatchesEmail(assertion.recipient, person.email)) {
      return { status: "verified", detail: "Бейдж Credly по ссылке выдан на email кандидата" };
    }
    return {
      status: "owner_mismatch",
      detail: "Бейдж Credly существует, но выдан на другой email — уточните у кандидата или проверьте вручную",
    };
  }
  const catalog = cert.catalog_id ? certificationById.get(cert.catalog_id) : null;
  const vendor = catalog ? vendorBySlug.get(catalog.vendor) : null;
  if (cert.url && /^https:\/\/learn\.microsoft\.com\//i.test(cert.url)) {
    return { status: "needs_manual", detail: "Откройте ссылку Microsoft Learn и сверьте имя и сертификат" };
  }
  return {
    status: "needs_manual",
    detail: vendor
      ? `${vendor.title}: открытого API нет — проверьте на ${vendor.verify.url}${cert.credential_id ? ` по номеру ${cert.credential_id}` : ""}`
      : "Нет автоматической проверки — проверьте по ссылке вручную",
  };
}

async function verifyClaimAndSave(certId, person) {
  const { rows } = await db.query("SELECT * FROM certificates WHERE id = $1", [certId]);
  const cert = rows[0];
  if (!cert || cert.reviewed_by) return;
  let verdict;
  try {
    verdict = await verifyClaim(cert, person);
  } catch (e) {
    verdict = { status: "claimed", detail: `Автопроверка не удалась: ${e.message}` };
  }
  await db.query("UPDATE certificates SET status = $1, status_detail = $2, checked_at = now() WHERE id = $3", [
    verdict.status,
    verdict.detail,
    certId,
  ]);
}

// Заявленный сертификат, который нашёлся подтверждённым бейджем Credly,
// тоже считается подтверждённым.
async function reconcileClaims(personId) {
  await db.query(
    `UPDATE certificates c SET status = 'verified', checked_at = now(),
       status_detail = 'Подтверждён бейджем Credly: ' || b.name
     FROM certificates b
     WHERE c.person_id = $1 AND b.person_id = $1
       AND c.source = 'candidate' AND b.source = 'credly'
       AND c.catalog_id IS NOT NULL AND c.catalog_id = b.catalog_id
       AND b.status = 'verified' AND c.status <> 'verified' AND c.reviewed_by IS NULL`,
    [personId]
  );
}

async function runOsint(personId, { trigger, reviewerId = null } = {}) {
  const person = await loadPerson(personId);
  if (!person) return null;
  const usernames = personUsernames(person);
  const { rows } = await db.query(
    "INSERT INTO osint_runs (person_id, trigger, requested_by, usernames) VALUES ($1, $2, $3, $4) RETURNING id",
    [personId, trigger, reviewerId, JSON.stringify(usernames)]
  );
  const runId = rows[0].id;
  try {
    const [sherlock, credlyResult] = await Promise.all([runSherlock(usernames), scanCredly(person, usernames)]);
    await saveCredlyBadges(personId, credlyResult.badges);

    const { rows: claims } = await db.query(
      "SELECT id FROM certificates WHERE person_id = $1 AND source = 'candidate' AND reviewed_by IS NULL AND status IN ('claimed', 'needs_manual', 'not_found')",
      [personId]
    );
    for (const c of claims) await verifyClaimAndSave(c.id, person);
    await reconcileClaims(personId);

    await db.query(
      `UPDATE osint_runs SET status = 'done', finished_at = now(), sherlock_available = $1, profiles = $2, credly = $3, error = $4
       WHERE id = $5`,
      [sherlock.available, JSON.stringify(sherlock.profiles), JSON.stringify(credlyResult.summary), sherlock.error, runId]
    );
  } catch (e) {
    await db
      .query("UPDATE osint_runs SET status = 'failed', finished_at = now(), error = $1 WHERE id = $2", [e.message, runId])
      .catch(() => {});
  }
  return runId;
}

// Фоновый запуск из обработчиков запросов: ответ не ждёт OSINT, ошибки
// только логируются (человека могли удалить, пока шёл поиск, и т.п.).
const inFlight = new Set();
function startOsintInBackground(personId, opts) {
  const p = runOsint(personId, opts)
    .catch((e) => console.error(`[osint] person ${personId}:`, e.message))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
  return p;
}

// Для тестов и корректного завершения: дождаться всех фоновых запусков.
function waitForOsintIdle() {
  return Promise.all([...inFlight]);
}

async function latestRun(personId) {
  const { rows } = await db.query(
    `SELECT id, trigger, status, usernames, sherlock_available, profiles, credly, error, started_at, finished_at
     FROM osint_runs WHERE person_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [personId]
  );
  return rows[0] || null;
}

module.exports = { runOsint, startOsintInBackground, waitForOsintIdle, verifyClaimAndSave, latestRun, loadPerson, personUsernames };
