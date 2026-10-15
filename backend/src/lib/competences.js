const fs = require("fs");
const path = require("path");

// Предметный индекс компетенций (src/content/competences.json): тематическая
// область ИБ -> пункты знаний/умений профстандартов, в тексте которых она
// встречается. Классификация — по дословному тексту пункта, без
// интерпретации: индекс только группирует то, что уже написано в
// стандарте, и проверяется по первоисточнику.
const TAXONOMY_PATH = path.join(__dirname, "..", "content", "competences.json");

// \b в JS не работает с кириллицей — границу слова задаём явно.
const LETTER = "[А-Яа-яЁёA-Za-z]";

function compileCompetence(c) {
  // Шаблоны — основы слов: засчитываем только совпадение с начала слова,
  // чтобы «сет» не находилось внутри «посетитель» и т.п.
  const stems = (c.patterns || []).map((p) => new RegExp(`(?<!${LETTER})(?:${p})`, "iu"));
  // Аббревиатуры — с учётом регистра и только целым словом: «НД» без
  // этого совпало бы с «стандарт» и «фонд».
  const abbreviations = (c.abbreviations || []).map((a) => new RegExp(`(?<!${LETTER})${a}(?!${LETTER})`, "u"));
  const excludes = (c.exclude || []).map((p) => new RegExp(p, "iu"));
  // Совпадение по названию ТФ относит к области все её пункты — для
  // областей, которые стандарт выделяет целой трудовой функцией.
  const laborFunctionMatchers = (c.laborFunctionPatterns || []).map((p) => new RegExp(`(?<!${LETTER})(?:${p})`, "iu"));
  return { ...c, matchers: [...stems, ...abbreviations], excludes, laborFunctionMatchers };
}

function loadTaxonomy(taxonomyPath = TAXONOMY_PATH) {
  const data = JSON.parse(fs.readFileSync(taxonomyPath, "utf8"));
  return data.competences.map(compileCompetence);
}

// Возвращает slug'и всех компетенций, к которым относится пункт: по его
// собственному тексту или по названию его трудовой функции.
function classify(text, laborFunctionTitle, taxonomy) {
  return taxonomy
    .filter(
      (c) =>
        (c.matchers.some((m) => m.test(text)) && !c.excludes.some((m) => m.test(text))) ||
        c.laborFunctionMatchers.some((m) => m.test(laborFunctionTitle || ""))
    )
    .map((c) => c.slug);
}

// Пересобирает таблицы competences / competence_items по текущей таксономии
// и текущим пунктам в БД. Идемпотентно: справочник обновляется по slug,
// связи пересоздаются целиком в одной транзакции.
async function rebuildIndex(client, taxonomy = loadTaxonomy()) {
  for (const [position, c] of taxonomy.entries()) {
    await client.query(
      `INSERT INTO competences (slug, title, description, position) VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET title = $2, description = $3, position = $4`,
      [c.slug, c.title, c.description || null, position]
    );
  }
  await client.query("DELETE FROM competences WHERE NOT (slug = ANY($1))", [taxonomy.map((c) => c.slug)]);

  const { rows: competenceRows } = await client.query("SELECT id, slug FROM competences");
  const idBySlug = new Map(competenceRows.map((r) => [r.slug, r.id]));

  await client.query("DELETE FROM competence_items");
  const { rows: items } = await client.query(
    `SELECT ci.id, ci.text, lf.title AS labor_function_title
     FROM competency_items ci JOIN labor_functions lf ON lf.id = ci.labor_function_id`
  );
  const competenceIds = [];
  const itemIds = [];
  let unmatched = 0;
  for (const item of items) {
    const slugs = classify(item.text, item.labor_function_title, taxonomy);
    if (slugs.length === 0) unmatched++;
    for (const slug of slugs) {
      competenceIds.push(idBySlug.get(slug));
      itemIds.push(item.id);
    }
  }
  if (itemIds.length) {
    await client.query(
      "INSERT INTO competence_items (competence_id, competency_item_id) SELECT * FROM unnest($1::int[], $2::int[])",
      [competenceIds, itemIds]
    );
  }
  return { competences: taxonomy.length, items: items.length, links: itemIds.length, unmatched };
}

module.exports = { loadTaxonomy, classify, rebuildIndex, TAXONOMY_PATH };
