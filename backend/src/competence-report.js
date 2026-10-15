// Генерирует docs/competence-index.md — читаемую версию предметного индекса
// компетенций: для каждой профессии (профстандарта) — какие области
// компетенций она требует и какие именно знания/умения в каждую входят.
// Строится напрямую из src/content/*.json (БД не нужна), поэтому совпадает
// с тем, что отдаёт API после seed/index-competences.
//   node src/competence-report.js          — перезаписать файл
//   node src/competence-report.js --check  — код 1, если файл устарел
const fs = require("fs");
const path = require("path");
const { loadTaxonomy, classify } = require("./lib/competences");

const CONTENT_DIR = path.join(__dirname, "content");
const OUTPUT_PATH = path.join(__dirname, "..", "..", "docs", "competence-index.md");
const STANDARD_CODES = ["06.030", "06.032", "06.033", "06.034", "06.053"];

function loadStandards() {
  return STANDARD_CODES.map((code) => JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, `${code}.json`), "utf8")));
}

// [{ standard, competences: [{ competence, knowledge: [{lf, text}], skills: [...] }], unmatched }]
function buildIndex(standards = loadStandards(), taxonomy = loadTaxonomy()) {
  return standards.map((standard) => {
    const bySlug = new Map(taxonomy.map((c) => [c.slug, { competence: c, knowledge: [], skills: [], laborFunctions: new Set() }]));
    let unmatched = 0;
    for (const gf of standard.generalized_functions) {
      for (const lf of gf.labor_functions) {
        for (const [kind, list] of [["knowledge", lf.knowledge], ["skills", lf.skills]]) {
          for (const text of list) {
            const slugs = classify(text, lf.title, taxonomy);
            if (slugs.length === 0) unmatched++;
            for (const slug of slugs) {
              const entry = bySlug.get(slug);
              entry[kind].push({ lf: lf.code, text });
              entry.laborFunctions.add(lf.code);
            }
          }
        }
      }
    }
    const competences = [...bySlug.values()]
      .filter((e) => e.knowledge.length + e.skills.length > 0)
      .sort((a, b) => b.knowledge.length + b.skills.length - (a.knowledge.length + a.skills.length));
    return { standard, competences, unmatched };
  });
}

function escapeCell(text) {
  return text.replace(/\|/g, "\\|");
}

function renderMarkdown(index = buildIndex(), taxonomy = loadTaxonomy()) {
  const out = [];
  out.push("# Индекс компетенций по профстандартам");
  out.push("");
  out.push("> Файл сгенерирован `node backend/src/competence-report.js` из `backend/src/content/*.json` и");
  out.push("> `backend/src/content/competences.json` — не редактируйте вручную, правьте таксономию и перегенерируйте.");
  out.push("");
  out.push(
    "Каждая область компетенций связана с пунктами знаний/умений профстандартов по совпадению с их **дословным** текстом " +
      "(см. `backend/src/lib/competences.js`): индекс только группирует то, что уже записано в стандарте, и не добавляет " +
      "требований от себя. Один пункт может входить в несколько областей. Код в скобках — трудовая функция (ТФ), из которой взят пункт."
  );
  out.push("");
  out.push("## Сводная матрица");
  out.push("");
  out.push("Число пунктов (знания + умения) каждой области в каждом стандарте.");
  out.push("");
  out.push(`| Область | ${index.map((s) => s.standard.code).join(" | ")} |`);
  out.push(`|---|${index.map(() => "---:").join("|")}|`);
  for (const c of taxonomy) {
    const cells = index.map((s) => {
      const e = s.competences.find((x) => x.competence.slug === c.slug);
      return e ? String(e.knowledge.length + e.skills.length) : "—";
    });
    out.push(`| ${escapeCell(c.title)} (\`${c.slug}\`) | ${cells.join(" | ")} |`);
  }
  out.push("");
  for (const { standard, competences, unmatched } of index) {
    out.push(`## ${standard.code} — ${standard.title}`);
    out.push("");
    out.push(`${standard.order}. Областей: ${competences.length}; пунктов вне индекса: ${unmatched}.`);
    out.push("");
    for (const { competence, knowledge, skills, laborFunctions } of competences) {
      out.push("<details>");
      out.push(
        `<summary><b>${competence.title}</b> — знаний: ${knowledge.length}, умений: ${skills.length}; ТФ: ${[...laborFunctions].join(", ")}</summary>`
      );
      out.push("");
      if (knowledge.length) {
        out.push("**Нужно знать**");
        out.push("");
        for (const k of knowledge) out.push(`- (${k.lf}) ${k.text}`);
        out.push("");
      }
      if (skills.length) {
        out.push("**Нужно уметь**");
        out.push("");
        for (const s of skills) out.push(`- (${s.lf}) ${s.text}`);
        out.push("");
      }
      out.push("</details>");
      out.push("");
    }
  }
  return out.join("\n");
}

if (require.main === module) {
  const markdown = renderMarkdown();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, "utf8") : "";
    if (current !== markdown) {
      console.error("docs/competence-index.md устарел — запустите node src/competence-report.js");
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, markdown);
    console.log(`Записан ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  }
}

module.exports = { buildIndex, renderMarkdown, OUTPUT_PATH };
