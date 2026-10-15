const fs = require("fs");
const path = require("path");
const { loadTaxonomy } = require("./competences");

// Каталог издателей сертификатов (src/content/certificate-issuers.json).
const CATALOG_PATH = path.join(__dirname, "..", "content", "certificate-issuers.json");

const issuers = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")).issuers;
const bySlug = new Map(issuers.map((i) => [i.slug, i]));
const competenceTitles = new Map(loadTaxonomy().map((c) => [c.slug, c.title]));

function getIssuer(slug) {
  return bySlug.get(slug) || null;
}

// Области компетенций и профстандарты, которые покрывает сертификат: из
// каталога, если название совпадает с известной сертификацией издателя;
// для «Другое» — пусто (ревьюер оценивает сам).
function coverageOf(issuerSlug, certificationName) {
  const issuer = getIssuer(issuerSlug);
  const known = issuer && issuer.certifications.find((c) => c.name === certificationName);
  return {
    competences: known ? known.competences.map((slug) => ({ slug, title: competenceTitles.get(slug) || slug })) : [],
    standards: (known && known.standards) || [],
  };
}

// Имя в сертификате: латиница для международных издателей, кириллица (как
// в паспорте) для российских документов.
const NAME_PATTERNS = {
  latin: /^[A-Za-z][A-Za-z .'-]*$/,
  cyrillic: /^[А-Яа-яЁё][А-Яа-яЁё .'-]*$/,
};

function validHolderName(issuer, name) {
  return NAME_PATTERNS[issuer.nameScript].test(name);
}

// Нормализация номера для blind index: регистр, пробелы и дефисы не важны.
function normalizeCredentialId(id) {
  return String(id).toUpperCase().replace(/[\s-]+/g, "");
}

module.exports = { issuers, getIssuer, coverageOf, validHolderName, normalizeCredentialId, NAME_PATTERNS };
