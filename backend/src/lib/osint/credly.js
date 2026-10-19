const crypto = require("crypto");

// Публичные данные Credly без API-ключа:
//   /users/<slug>/badges.json                    — бейджи публичного профиля
//   /api/v1/obi/v2/badge_assertions/<badge-id>   — Open Badges 2.0 assertion;
//     в нём recipient — sha256-хэш email получателя, поэтому бейдж можно
//     проверить на принадлежность email кандидата, не зная email из Credly.
// Базовый URL переопределяется CREDLY_BASE_URL (тесты поднимают фейковый Credly).
function baseUrl() {
  return (process.env.CREDLY_BASE_URL || "https://www.credly.com").replace(/\/$/, "");
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_BADGES = 50;
const BADGE_URL_RE = /credly\.com\/(?:badges|earner\/earned\/badge)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,80}$/i;

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "competence-check-platform/0.1 (+osint)" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Credly ответил ${res.status} на ${url}`);
  return res.json();
}

// null — профиля нет; [] — профиль есть, публичных бейджей нет.
async function fetchProfileBadges(slug) {
  if (!SLUG_RE.test(slug)) return null;
  const data = await fetchJson(`${baseUrl()}/users/${encodeURIComponent(slug)}/badges.json`);
  if (!data || !Array.isArray(data.data)) return null;
  return data.data.slice(0, MAX_BADGES).map((b) => {
    const template = b.badge_template || {};
    const issuerEntity = b.issuer && Array.isArray(b.issuer.entities) && b.issuer.entities[0];
    return {
      id: b.id,
      name: template.name || "Бейдж Credly",
      issuer: (issuerEntity && issuerEntity.entity && issuerEntity.entity.name) || (b.issuer && b.issuer.summary) || "",
      issuedTo: b.issued_to || null,
      issuedOn: b.issued_at_date || null,
      expiresOn: b.expires_at_date || null,
      url: `https://www.credly.com/badges/${b.id}`,
      skills: Array.isArray(template.skills) ? template.skills.map((s) => s.name) : [],
    };
  });
}

async function fetchAssertion(badgeId) {
  return fetchJson(`${baseUrl()}/api/v1/obi/v2/badge_assertions/${encodeURIComponent(badgeId)}`);
}

// Название бейджа и издатель по assertion -> badge class -> issuer (для
// бейджа, присланного кандидатом ссылкой, когда профиля у нас нет).
async function fetchBadgeClass(assertion) {
  if (!assertion || typeof assertion.badge !== "string") return null;
  const badgeClassUrl = assertion.badge.replace(/^https:\/\/www\.credly\.com/, baseUrl());
  const badgeClass = await fetchJson(badgeClassUrl);
  if (!badgeClass) return null;
  const issuer = typeof badgeClass.issuer === "object" ? badgeClass.issuer : null;
  return { name: badgeClass.name, issuer: issuer ? issuer.name : "" };
}

// Open Badges 2.0: identity = "sha256$" + hex(sha256(email + salt)).
function recipientMatchesEmail(recipient, email) {
  if (!recipient || typeof recipient.identity !== "string" || !email) return false;
  const candidates = [...new Set([email.trim(), email.trim().toLowerCase()])];
  if (!recipient.hashed) return candidates.includes(recipient.identity.trim().toLowerCase());
  const [algo, hex] = recipient.identity.split("$");
  if (!hex || !["sha256", "sha512", "md5"].includes(algo)) return false;
  return candidates.some(
    (e) => crypto.createHash(algo).update(e + (recipient.salt || "")).digest("hex") === hex.toLowerCase()
  );
}

function parseBadgeUrl(url) {
  const m = BADGE_URL_RE.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

module.exports = { fetchProfileBadges, fetchAssertion, fetchBadgeClass, recipientMatchesEmail, parseBadgeUrl };
