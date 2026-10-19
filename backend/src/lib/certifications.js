const fs = require("fs");
const path = require("path");
const { compilePattern } = require("./topics");

const CATALOG_PATH = path.join(__dirname, "..", "content", "certifications.json");

// Каталог вендорских сертификатов — справочник, а не данные БД: меняется
// правкой content/certifications.json, без миграций.
const raw = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
const vendors = raw.vendors;
const vendorBySlug = new Map(vendors.map((v) => [v.slug, v]));
const certifications = raw.certifications.map((c) => ({
  ...c,
  vendorTitle: vendorBySlug.get(c.vendor).title,
  regex: c.credlyPattern ? compilePattern(c.credlyPattern) : null,
}));
const certificationById = new Map(certifications.map((c) => [c.id, c]));

function publicCertification(c) {
  const vendor = vendorBySlug.get(c.vendor);
  return {
    id: c.id,
    vendor: c.vendor,
    vendorTitle: vendor.title,
    name: c.name,
    level: c.level,
    topics: c.topics,
    verify: vendor.verify,
  };
}

// Распознаёт бейдж Credly как сертификат из каталога: по названию бейджа и,
// если у вендора есть credlyIssuer, по издателю — чтобы, например, учебный
// курс «Security+ Prep» от стороннего издателя не засчитывался как CompTIA Security+.
// Учебные бейджи (курсы, «training badge», подготовка) — не сертификаты,
// даже если в названии есть «CCNA» или «Security+».
const TRAINING_BADGE_RE = /training badge|introduction to|\bcourse\b|\bprep\b|learning path|exam prep|\bessentials\b/i;

function matchCatalog(badgeName, issuerName) {
  if (TRAINING_BADGE_RE.test(badgeName)) return null;
  for (const c of certifications) {
    if (!c.regex || !c.regex.test(badgeName)) continue;
    const vendor = vendorBySlug.get(c.vendor);
    if (vendor.credlyIssuer && issuerName && !issuerName.toLowerCase().includes(vendor.credlyIssuer.toLowerCase())) continue;
    return c;
  }
  return null;
}

module.exports = { vendors, vendorBySlug, certifications, certificationById, publicCertification, matchCatalog };
