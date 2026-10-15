const db = require("../db");
const { encrypt, decrypt, blindIndex } = require("../lib/pii");
const { logAccess } = require("../lib/accessLog");
const { issuers, getIssuer, coverageOf, validHolderName, normalizeCredentialId, NAME_PATTERNS } = require("../lib/certificateIssuers");
const { resolveParticipantFromSession } = require("./participantAuth");
const { resolveReviewerFromSession } = require("./auth");

// Сертификаты участника: участник заявляет сертификат (издатель, название,
// имя как в сертификате, номер), ревьюер проверяет его вручную на странице
// издателя по связке «имя + номер» и отмечает verified / rejected.
// Публичного поиска по одному имени у издателей нет, а API для
// автоматической проверки они не дают — см. src/content/certificate-issuers.json.

const MAX_CERTIFICATES_PER_PERSON = 30;
const MAX_TEXT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function credentialHash(issuer, credentialId) {
  return blindIndex(`${issuer}:${normalizeCredentialId(credentialId)}`);
}

function isText(v, max = MAX_TEXT) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function validDate(v) {
  return typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function toIsoDate(d) {
  // DATE из pg приходит как Date в локальной зоне — берём календарную дату.
  if (!d) return null;
  if (typeof d === "string") return d;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function certificateView(row) {
  const issuer = getIssuer(row.issuer);
  const expiresOn = toIsoDate(row.expires_on);
  return {
    id: row.id,
    issuer: row.issuer,
    issuerName: issuer ? issuer.name : row.issuer,
    certification: row.certification,
    holderName: decrypt(row.holder_name),
    credentialId: decrypt(row.credential_id),
    issuedOn: toIsoDate(row.issued_on),
    expiresOn,
    expired: Boolean(expiresOn && expiresOn < toIsoDate(new Date())),
    badgeUrl: row.badge_url ? decrypt(row.badge_url) : null,
    verificationStatus: row.verification_status,
    verificationNote: row.verification_note,
    verifiedAt: row.verified_at,
    ...coverageOf(row.issuer, row.certification),
  };
}

// GET /api/certificate-issuers — справочник для формы участника (открытый).
function listIssuers(req, res) {
  res.json(
    issuers.map((i) => ({
      slug: i.slug,
      name: i.name,
      region: i.region,
      nameScript: i.nameScript,
      credentialLabel: i.credentialLabel,
      credentialHint: i.credentialHint,
      certifications: i.certifications.map((c) => ({ name: c.name, ...coverageOf(i.slug, c.name) })),
    }))
  );
}

async function requireParticipant(req, res) {
  const person = await resolveParticipantFromSession(req);
  if (!person) res.status(401).json({ error: "Не авторизован" });
  return person;
}

// PATCH /api/participant/profile  body: { nameLatin }
// Имя латиницей, как в международных сертификатах; пустая строка — удалить.
async function updateProfile(req, res) {
  const person = await requireParticipant(req, res);
  if (!person) return;
  const { nameLatin } = req.body || {};
  if (typeof nameLatin !== "string" || nameLatin.length > MAX_TEXT) {
    res.status(400).json({ error: "nameLatin должен быть строкой" });
    return;
  }
  const value = nameLatin.trim();
  if (value && !NAME_PATTERNS.latin.test(value)) {
    res.status(400).json({ error: "Имя латиницей: только латинские буквы, пробел, дефис, апостроф, точка" });
    return;
  }
  await db.query("UPDATE people SET name_latin = $1 WHERE id = $2", [value ? encrypt(value) : null, person.id]);
  res.json({ nameLatin: value || null });
}

// GET /api/participant/certificates
async function listOwnCertificates(req, res) {
  const person = await requireParticipant(req, res);
  if (!person) return;
  const { rows } = await db.query("SELECT * FROM participant_certificates WHERE person_id = $1 ORDER BY created_at, id", [person.id]);
  res.json(rows.map(certificateView));
}

// POST /api/participant/certificates
// body: { issuer, certification, holderName, credentialId, issuedOn?, expiresOn?, badgeUrl? }
async function addCertificate(req, res) {
  const person = await requireParticipant(req, res);
  if (!person) return;
  const { issuer: issuerSlug, certification, holderName, credentialId, issuedOn, expiresOn, badgeUrl } = req.body || {};

  const issuer = getIssuer(issuerSlug);
  if (!issuer) {
    res.status(400).json({ error: "Неизвестный издатель сертификата" });
    return;
  }
  if (!isText(certification) || !isText(holderName) || !isText(credentialId, 100)) {
    res.status(400).json({ error: "certification, holderName и credentialId обязательны" });
    return;
  }
  if (!validHolderName(issuer, holderName.trim())) {
    res.status(400).json({
      error:
        issuer.nameScript === "latin"
          ? "Имя укажите латиницей, точно как в сертификате"
          : "ФИО укажите кириллицей, как в документе",
    });
    return;
  }
  for (const [field, value] of [["issuedOn", issuedOn], ["expiresOn", expiresOn]]) {
    if (value !== undefined && value !== null && value !== "" && !validDate(value)) {
      res.status(400).json({ error: `${field}: дата в формате ГГГГ-ММ-ДД` });
      return;
    }
  }
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    res.status(400).json({ error: "Срок действия не может закончиться раньше даты выдачи" });
    return;
  }
  if (badgeUrl) {
    let url = null;
    try {
      url = new URL(badgeUrl);
    } catch (e) {
      /* проверка ниже */
    }
    if (!url || url.protocol !== "https:" || badgeUrl.length > 500) {
      res.status(400).json({ error: "Ссылка на бейдж должна быть https-адресом" });
      return;
    }
  }

  const { rows: countRows } = await db.query("SELECT count(*)::int AS n FROM participant_certificates WHERE person_id = $1", [person.id]);
  if (countRows[0].n >= MAX_CERTIFICATES_PER_PERSON) {
    res.status(400).json({ error: `Не больше ${MAX_CERTIFICATES_PER_PERSON} сертификатов` });
    return;
  }

  const { rows } = await db.query(
    `INSERT INTO participant_certificates
       (person_id, issuer, certification, holder_name, credential_id, credential_hash, issued_on, expires_on, badge_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (person_id, credential_hash) DO NOTHING
     RETURNING *`,
    [
      person.id,
      issuer.slug,
      certification.trim(),
      encrypt(holderName.trim()),
      encrypt(credentialId.trim()),
      credentialHash(issuer.slug, credentialId),
      issuedOn || null,
      expiresOn || null,
      badgeUrl ? encrypt(badgeUrl) : null,
    ]
  );
  if (!rows[0]) {
    res.status(409).json({ error: "Этот сертификат уже добавлен" });
    return;
  }
  res.status(201).json(certificateView(rows[0]));
}

// DELETE /api/participant/certificates/:id — только свои; подтверждённый
// ревьюером сертификат удалить можно (это решение участника), но в отчётах
// он тогда тоже пропадёт.
async function deleteCertificate(req, res) {
  const person = await requireParticipant(req, res);
  if (!person) return;
  const id = Number(req.params.id);
  const { rowCount } = Number.isInteger(id)
    ? await db.query("DELETE FROM participant_certificates WHERE id = $1 AND person_id = $2", [id, person.id])
    : { rowCount: 0 };
  if (!rowCount) {
    res.status(404).json({ error: "Сертификат не найден" });
    return;
  }
  res.json({ ok: true });
}

// Для отчёта ревьюера: сертификаты участника проверки + как их проверять +
// сколько других участников заявили тот же номер (признак для ревьюера,
// не автоматический отказ).
async function certificatesForReport(personId, standardCode) {
  const { rows } = await db.query(
    `SELECT pc.*,
            (SELECT count(*)::int FROM participant_certificates o
             WHERE o.credential_hash = pc.credential_hash AND o.person_id <> pc.person_id) AS same_number_elsewhere
     FROM participant_certificates pc
     WHERE pc.person_id = $1
     ORDER BY pc.created_at, pc.id`,
    [personId]
  );
  const { rows: standardCompetences } = await db.query(
    `SELECT DISTINCT c.slug FROM competences c
     JOIN competence_items cmi ON cmi.competence_id = c.id
     JOIN competency_items ci ON ci.id = cmi.competency_item_id
     JOIN labor_functions lf ON lf.id = ci.labor_function_id
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     JOIN standards s ON s.id = gf.standard_id
     WHERE s.code = $1`,
    [standardCode]
  );
  const relevant = new Set(standardCompetences.map((r) => r.slug));
  return rows.map((row) => {
    const view = certificateView(row);
    const issuer = getIssuer(row.issuer);
    return {
      ...view,
      competences: view.competences.map((c) => ({ ...c, relevantToStandard: relevant.has(c.slug) })),
      matchesStandard: view.standards.includes(standardCode),
      sameNumberElsewhere: row.same_number_elsewhere,
      verify: issuer
        ? {
            url: issuer.verifyUrl,
            urlConfirmed: issuer.verifyUrlConfirmed,
            how: issuer.verifyHow,
            credentialLabel: issuer.credentialLabel,
          }
        : null,
    };
  });
}

// POST /api/assessments/:assessmentId/certificates/:certificateId/verification
// body: { status: 'verified' | 'rejected' | 'pending', note? }
// Ревьюер отмечает результат ручной проверки. Привязано к проверке, чтобы
// действие попало в журнал доступа рядом с остальными действиями по ней.
async function verifyCertificate(req, res) {
  const reviewer = await resolveReviewerFromSession(req);
  if (!reviewer) {
    res.status(401).json({ error: "Требуется вход (сессия истекла или отсутствует)" });
    return;
  }
  const assessmentId = Number(req.params.assessmentId);
  const certificateId = Number(req.params.certificateId);
  const { status, note } = req.body || {};
  if (!["verified", "rejected", "pending"].includes(status)) {
    res.status(400).json({ error: "status должен быть verified | rejected | pending" });
    return;
  }
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > 1000)) {
    res.status(400).json({ error: "note — строка до 1000 символов" });
    return;
  }
  if (!Number.isInteger(assessmentId) || !Number.isInteger(certificateId)) {
    res.status(404).json({ error: "Сертификат не найден" });
    return;
  }
  const { rows } = await db.query(
    `UPDATE participant_certificates pc
     SET verification_status = $1,
         verification_note = $2,
         verified_by = CASE WHEN $1 = 'pending' THEN NULL ELSE $3::int END,
         verified_at = CASE WHEN $1 = 'pending' THEN NULL ELSE now() END
     FROM assessments a
     WHERE pc.id = $4 AND a.id = $5 AND a.person_id = pc.person_id
     RETURNING pc.*`,
    [status, note ? note.trim() : null, reviewer.id, certificateId, assessmentId]
  );
  if (!rows[0]) {
    res.status(404).json({ error: "Сертификат не найден" });
    return;
  }
  await logAccess(reviewer.id, assessmentId, "verify_certificate");
  res.json(certificateView(rows[0]));
}

module.exports = {
  listIssuers,
  updateProfile,
  listOwnCertificates,
  addCertificate,
  deleteCertificate,
  certificatesForReport,
  verifyCertificate,
};
