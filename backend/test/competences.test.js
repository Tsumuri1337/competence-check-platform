const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { startTestServer, pool } = require("../test-support/helpers");
const { loadTaxonomy, classify } = require("../src/lib/competences");
const { buildIndex, renderMarkdown, OUTPUT_PATH } = require("../src/competence-report");

let server, baseUrl;
const taxonomy = loadTaxonomy();

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
});

test.after(async () => {
  server.close();
  await pool.end();
});

test("abbreviations match only as whole, case-sensitive words", () => {
  // «НД» (несанкционированный доступ) не должно находиться внутри «стандарт»/«фонд».
  assert.ok(!classify("Национальные стандарты в области защиты информации", "", taxonomy).includes("access-control"));
  assert.ok(classify("Средства защиты СССЭ от НД", "", taxonomy).includes("access-control"));
});

test("stems match from the start of a word only", () => {
  assert.ok(classify("Архитектура операционных систем", "", taxonomy).includes("os-security"));
  assert.ok(!classify("Посетители объекта", "", taxonomy).includes("network-security"));
});

test("a labor function devoted to an area pulls all of its items into it", () => {
  const lf = "Проведение экспертизы при расследовании компьютерных преступлений, правонарушений и инцидентов";
  assert.ok(classify("Основные форматы файлов, используемые в компьютерных системах", lf, taxonomy).includes("forensics"));
});

test("every competence area is backed by items of at least one standard, and almost every item is indexed", () => {
  const index = buildIndex();
  for (const c of taxonomy) {
    assert.ok(
      index.some((s) => s.competences.some((e) => e.competence.slug === c.slug)),
      `область ${c.slug} не нашла ни одного пункта`
    );
  }
  const total = index.reduce((n, s) => n + s.standard.generalized_functions.flatMap((g) => g.labor_functions).reduce((m, lf) => m + lf.knowledge.length + lf.skills.length, 0), 0);
  const unmatched = index.reduce((n, s) => n + s.unmatched, 0);
  assert.ok(unmatched / total < 0.05, `вне индекса ${unmatched} из ${total} пунктов`);
});

test("docs/competence-index.md is up to date with the taxonomy", () => {
  assert.equal(fs.readFileSync(OUTPUT_PATH, "utf8"), renderMarkdown(), "перегенерируйте: node src/competence-report.js");
});

test("GET /api/competences lists every area with per-standard counts", async () => {
  const res = await fetch(`${baseUrl}/api/competences`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.deepEqual(
    list.map((c) => c.slug),
    taxonomy.map((c) => c.slug)
  );
  const forensics = list.find((c) => c.slug === "forensics");
  const s032 = forensics.standards.find((s) => s.code === "06.032");
  assert.ok(s032.knowledge > 0 && s032.skills > 0);
});

test("GET /api/competences/:slug groups items by standard and labor function, and filters by standard", async () => {
  const all = await fetch(`${baseUrl}/api/competences/cryptography`).then((r) => r.json());
  assert.ok(all.standards.length > 1);
  const lf = all.standards[0].laborFunctions[0];
  assert.ok(lf.code && lf.title && lf.generalizedFunction.qualificationLevel);
  assert.ok(lf.knowledge.length + lf.skills.length > 0);

  const one = await fetch(`${baseUrl}/api/competences/cryptography?standardCode=06.032`).then((r) => r.json());
  assert.deepEqual(
    one.standards.map((s) => s.code),
    ["06.032"]
  );

  assert.equal((await fetch(`${baseUrl}/api/competences/no-such-area`)).status, 404);
});

test("GET /api/standards/:code/competences returns the job's competence profile", async () => {
  const res = await fetch(`${baseUrl}/api/standards/06.053/competences`);
  assert.equal(res.status, 200);
  const profile = await res.json();
  assert.equal(profile.code, "06.053");
  const slugs = profile.competences.map((c) => c.slug);
  assert.ok(slugs.includes("financial-sector"));
  assert.ok(slugs.includes("personal-data"));
  assert.ok(!slugs.includes("technical-leakage-channels"));
  for (const c of profile.competences) assert.ok(c.laborFunctions.length > 0 && c.qualificationLevels.length > 0);

  assert.equal((await fetch(`${baseUrl}/api/standards/99.999/competences`)).status, 404);
});

test("GET /api/standards/:code tags each item with its competence areas", async () => {
  const standard = await fetch(`${baseUrl}/api/standards/06.032`).then((r) => r.json());
  const items = standard.generalizedFunctions.flatMap((g) => g.laborFunctions).flatMap((lf) => [...lf.knowledge, ...lf.skills]);
  assert.ok(items.every((i) => Array.isArray(i.competences)));
  assert.ok(items.some((i) => i.competences.includes("os-security")));
});
