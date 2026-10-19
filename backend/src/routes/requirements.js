const db = require("../db");
const { certifications, publicCertification } = require("../lib/certifications");

// Публичный справочник требований (вкладка «Требования», requirements.html).
// Иерархия:
//   должность (профстандарт) -> ОТФ -> компетенция (трудовая функция, ТФ)
//     -> знания (что нужно знать) и умения (что нужно уметь делать)
//   + поперечный индекс тем (VPN, ЛВС, криптография, ...) поверх знаний/умений
//     и связь тем с вендорскими сертификатами.
// Всё открыто без входа: профстандарты — публичные документы, а смотреть
// требования нужно и кандидатам до проверки, и ревьюерам.

function certificationsForTopics(slugs) {
  const set = new Set(slugs);
  return certifications
    .filter((c) => c.topics.some((t) => set.has(t)))
    .map((c) => ({ ...publicCertification(c), matchedTopics: c.topics.filter((t) => set.has(t)) }))
    .sort((a, b) => b.matchedTopics.length - a.matchedTopics.length);
}

// GET /api/topics — все темы с количеством пунктов по каждому профстандарту.
async function listTopics(req, res) {
  const [topics, perStandard, questions] = await Promise.all([
    db.query("SELECT id, slug, category, category_title, title, title_en, description FROM topics ORDER BY sort_order"),
    db.query(
      `SELECT cit.topic_id, s.code, count(*)::int AS items, count(DISTINCT lf.id)::int AS functions
       FROM competency_item_topics cit
       JOIN competency_items ci ON ci.id = cit.competency_item_id
       JOIN labor_functions lf ON lf.id = ci.labor_function_id
       JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
       JOIN standards s ON s.id = gf.standard_id
       GROUP BY cit.topic_id, s.code`
    ),
    db.query("SELECT topic_id, count(*)::int AS n FROM quiz_question_topics GROUP BY topic_id"),
  ]);
  const byTopic = new Map();
  for (const r of perStandard.rows) {
    if (!byTopic.has(r.topic_id)) byTopic.set(r.topic_id, {});
    byTopic.get(r.topic_id)[r.code] = { items: r.items, functions: r.functions };
  }
  const questionCount = new Map(questions.rows.map((r) => [r.topic_id, r.n]));
  res.json(
    topics.rows.map((t) => {
      const standards = byTopic.get(t.id) || {};
      return {
        slug: t.slug,
        title: t.title,
        titleEn: t.title_en,
        category: t.category,
        categoryTitle: t.category_title,
        description: t.description,
        itemCount: Object.values(standards).reduce((sum, s) => sum + s.items, 0),
        standards,
        questionCount: questionCount.get(t.id) || 0,
        certificationCount: certifications.filter((c) => c.topics.includes(t.slug)).length,
      };
    })
  );
}

// Пункты знаний/умений, сгруппированные профстандарт -> ТФ.
function groupItems(rows) {
  const standards = new Map();
  for (const r of rows) {
    if (!standards.has(r.standard_code)) {
      standards.set(r.standard_code, { code: r.standard_code, title: r.standard_title, laborFunctions: new Map() });
    }
    const lfs = standards.get(r.standard_code).laborFunctions;
    if (!lfs.has(r.lf_id)) {
      lfs.set(r.lf_id, { id: r.lf_id, code: r.lf_code, title: r.lf_title, knowledge: [], skills: [] });
    }
    lfs.get(r.lf_id)[r.kind === "knowledge" ? "knowledge" : "skills"].push({ id: r.id, text: r.text });
  }
  return [...standards.values()].map((s) => ({ ...s, laborFunctions: [...s.laborFunctions.values()] }));
}

const ITEM_COLUMNS = `ci.id, ci.kind, ci.text, lf.id AS lf_id, lf.code AS lf_code, lf.title AS lf_title,
  s.code AS standard_code, s.title AS standard_title`;
const ITEM_JOINS = `JOIN labor_functions lf ON lf.id = ci.labor_function_id
  JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
  JOIN standards s ON s.id = gf.standard_id`;

// GET /api/topics/:slug[?standard=06.030] — что именно требуется по теме:
// по каждому профстандарту — компетенции (ТФ) и их знания/умения.
async function getTopic(req, res) {
  const { rows } = await db.query(
    "SELECT id, slug, category, category_title, title, title_en, description FROM topics WHERE slug = $1",
    [req.params.slug]
  );
  const topic = rows[0];
  if (!topic) {
    res.status(404).json({ error: "Тема не найдена" });
    return;
  }
  const args = [topic.id];
  let filter = "";
  if (req.query.standard) {
    args.push(req.query.standard);
    filter = ` AND s.code = $2`;
  }
  const [items, questions] = await Promise.all([
    db.query(
      `SELECT ${ITEM_COLUMNS} FROM competency_item_topics cit
       JOIN competency_items ci ON ci.id = cit.competency_item_id ${ITEM_JOINS}
       WHERE cit.topic_id = $1${filter} ORDER BY s.code, lf.code, ci.kind, ci.id`,
      args
    ),
    db.query("SELECT count(*)::int AS n FROM quiz_question_topics WHERE topic_id = $1", [topic.id]),
  ]);
  res.json({
    slug: topic.slug,
    title: topic.title,
    titleEn: topic.title_en,
    category: topic.category,
    categoryTitle: topic.category_title,
    description: topic.description,
    questionCount: questions.rows[0].n,
    standards: groupItems(items.rows),
    certifications: certificationsForTopics([topic.slug]),
  });
}

// GET /api/standards/:code/topics — тематический индекс должности: какие
// темы нужно знать по этому профстандарту и насколько они весомы.
async function getStandardTopicIndex(req, res) {
  const standard = await db.query("SELECT id, code, title FROM standards WHERE code = $1", [req.params.code]);
  if (!standard.rows[0]) {
    res.status(404).json({ error: "Профстандарт не найден" });
    return;
  }
  const { id, code, title } = standard.rows[0];
  const [topics, totals] = await Promise.all([
    db.query(
      `SELECT t.slug, t.title, t.title_en, t.category, t.category_title, t.description,
         count(*) FILTER (WHERE ci.kind = 'knowledge')::int AS knowledge,
         count(*) FILTER (WHERE ci.kind = 'skill')::int AS skills,
         array_agg(DISTINCT lf.code ORDER BY lf.code) AS labor_functions
       FROM competency_item_topics cit
       JOIN topics t ON t.id = cit.topic_id
       JOIN competency_items ci ON ci.id = cit.competency_item_id
       JOIN labor_functions lf ON lf.id = ci.labor_function_id
       JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
       WHERE gf.standard_id = $1
       GROUP BY t.slug, t.title, t.title_en, t.category, t.category_title, t.description, t.sort_order
       ORDER BY t.sort_order`,
      [id]
    ),
    db.query(
      `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM competency_item_topics x WHERE x.competency_item_id = ci.id))::int AS untagged
       FROM competency_items ci
       JOIN labor_functions lf ON lf.id = ci.labor_function_id
       JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
       WHERE gf.standard_id = $1`,
      [id]
    ),
  ]);
  const categories = new Map();
  for (const t of topics.rows) {
    if (!categories.has(t.category)) categories.set(t.category, { slug: t.category, title: t.category_title, topics: [] });
    categories.get(t.category).topics.push({
      slug: t.slug,
      title: t.title,
      titleEn: t.title_en,
      description: t.description,
      knowledge: t.knowledge,
      skills: t.skills,
      laborFunctions: t.labor_functions,
    });
  }
  res.json({
    code,
    title,
    totalItems: totals.rows[0].total,
    untaggedItems: totals.rows[0].untagged,
    categories: [...categories.values()],
    certifications: certificationsForTopics(topics.rows.map((t) => t.slug)).slice(0, 12),
  });
}

async function topicsForItems(itemIds) {
  if (!itemIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT cit.competency_item_id, t.slug, t.title FROM competency_item_topics cit
     JOIN topics t ON t.id = cit.topic_id WHERE cit.competency_item_id = ANY($1) ORDER BY t.sort_order`,
    [itemIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.competency_item_id)) map.set(r.competency_item_id, []);
    map.get(r.competency_item_id).push({ slug: r.slug, title: r.title });
  }
  return map;
}

// GET /api/labor-functions/:id — компетенция (ТФ): какие знания и умения
// она требует, по каким темам, в какой должности.
async function getLaborFunction(req, res) {
  const { rows } = await db.query(
    `SELECT lf.id, lf.code, lf.title, gf.code AS gf_code, gf.title AS gf_title, gf.qualification_level,
       s.code AS standard_code, s.title AS standard_title
     FROM labor_functions lf
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     JOIN standards s ON s.id = gf.standard_id
     WHERE lf.id = $1`,
    [Number(req.params.id)]
  );
  const lf = rows[0];
  if (!lf) {
    res.status(404).json({ error: "Трудовая функция не найдена" });
    return;
  }
  const items = await db.query("SELECT id, kind, text FROM competency_items WHERE labor_function_id = $1 ORDER BY kind, id", [lf.id]);
  const topicMap = await topicsForItems(items.rows.map((i) => i.id));
  const withTopics = items.rows.map((i) => ({ id: i.id, text: i.text, topics: topicMap.get(i.id) || [] }));
  const topicCounts = new Map();
  for (const i of withTopics) for (const t of i.topics) topicCounts.set(t.slug, { ...t, count: (topicCounts.get(t.slug)?.count || 0) + 1 });
  const topics = [...topicCounts.values()].sort((a, b) => b.count - a.count);
  res.json({
    id: lf.id,
    code: lf.code,
    title: lf.title,
    generalizedFunction: { code: lf.gf_code, title: lf.gf_title, qualificationLevel: lf.qualification_level },
    standard: { code: lf.standard_code, title: lf.standard_title },
    knowledge: withTopics.filter((_, idx) => items.rows[idx].kind === "knowledge"),
    skills: withTopics.filter((_, idx) => items.rows[idx].kind === "skill"),
    topics,
    certifications: certificationsForTopics(topics.map((t) => t.slug)).slice(0, 8),
  });
}

// GET /api/competency-items/:id — один пункт (знание или умение) и его связи:
//   - компетенция (ТФ), которой он нужен, и должность;
//   - «парные» пункты той же ТФ противоположного вида: для умения — какие
//     знания нужны, чтобы его выполнять, для знания — в каких умениях оно
//     применяется (сначала — с общими темами);
//   - те же темы в других должностях.
async function getCompetencyItem(req, res) {
  const { rows } = await db.query(`SELECT ${ITEM_COLUMNS}, gf.code AS gf_code, gf.title AS gf_title FROM competency_items ci ${ITEM_JOINS} WHERE ci.id = $1`, [
    Number(req.params.id),
  ]);
  const item = rows[0];
  if (!item) {
    res.status(404).json({ error: "Пункт не найден" });
    return;
  }
  const siblings = await db.query(
    "SELECT id, kind, text FROM competency_items WHERE labor_function_id = $1 AND id <> $2 ORDER BY id",
    [item.lf_id, item.id]
  );
  const topicMap = await topicsForItems([item.id, ...siblings.rows.map((r) => r.id)]);
  const itemTopics = topicMap.get(item.id) || [];
  const itemTopicSlugs = new Set(itemTopics.map((t) => t.slug));
  const related = siblings.rows
    .map((r) => {
      const topics = topicMap.get(r.id) || [];
      return { id: r.id, kind: r.kind, text: r.text, sharedTopics: topics.filter((t) => itemTopicSlugs.has(t.slug)).map((t) => t.title) };
    })
    .sort((a, b) => b.sharedTopics.length - a.sharedTopics.length);

  let otherStandards = [];
  if (itemTopics.length) {
    const other = await db.query(
      `SELECT s.code, s.title, count(DISTINCT ci.id)::int AS items, count(DISTINCT lf.id)::int AS functions
       FROM competency_item_topics cit
       JOIN topics t ON t.id = cit.topic_id
       JOIN competency_items ci ON ci.id = cit.competency_item_id ${ITEM_JOINS}
       WHERE t.slug = ANY($1) AND s.code <> $2
       GROUP BY s.code, s.title ORDER BY s.code`,
      [[...itemTopicSlugs], item.standard_code]
    );
    otherStandards = other.rows;
  }

  const counterpart = item.kind === "skill" ? "knowledge" : "skill";
  res.json({
    id: item.id,
    kind: item.kind,
    text: item.text,
    topics: itemTopics,
    laborFunction: { id: item.lf_id, code: item.lf_code, title: item.lf_title },
    generalizedFunction: { code: item.gf_code, title: item.gf_title },
    standard: { code: item.standard_code, title: item.standard_title },
    counterparts: related.filter((r) => r.kind === counterpart),
    sameKind: related.filter((r) => r.kind === item.kind),
    otherStandards,
    certifications: certificationsForTopics([...itemTopicSlugs]).slice(0, 6),
  });
}

// GET /api/requirements/search?q=vpn[&standard=06.030] — поиск по темам,
// компетенциям (ТФ) и знаниям/умениям.
async function search(req, res) {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    res.status(400).json({ error: "Запрос — минимум 2 символа" });
    return;
  }
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const args = [pattern];
  let filter = "";
  if (req.query.standard) {
    args.push(req.query.standard);
    filter = " AND s.code = $2";
  }
  const [topics, functions, items] = await Promise.all([
    db.query(
      "SELECT slug, title, title_en, category_title FROM topics WHERE title ILIKE $1 OR title_en ILIKE $1 OR description ILIKE $1 OR slug ILIKE $1 ORDER BY sort_order",
      [pattern]
    ),
    db.query(
      `SELECT lf.id, lf.code, lf.title, s.code AS standard_code FROM labor_functions lf
       JOIN generalized_functions gf ON gf.id = lf.generalized_function_id JOIN standards s ON s.id = gf.standard_id
       WHERE (lf.title ILIKE $1 OR lf.code ILIKE $1)${filter} ORDER BY s.code, lf.code LIMIT 30`,
      args
    ),
    db.query(
      `SELECT ${ITEM_COLUMNS} FROM competency_items ci ${ITEM_JOINS}
       WHERE ci.text ILIKE $1${filter} ORDER BY s.code, lf.code, ci.id LIMIT 60`,
      args
    ),
  ]);
  res.json({
    topics: topics.rows.map((t) => ({ slug: t.slug, title: t.title, titleEn: t.title_en, categoryTitle: t.category_title })),
    laborFunctions: functions.rows,
    items: items.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.text,
      laborFunction: { id: r.lf_id, code: r.lf_code, title: r.lf_title },
      standardCode: r.standard_code,
    })),
  });
}

// GET /api/certifications — каталог вендорских сертификатов.
function listCertifications(req, res) {
  res.json(certifications.map(publicCertification));
}

module.exports = {
  listTopics,
  getTopic,
  getStandardTopicIndex,
  getLaborFunction,
  getCompetencyItem,
  search,
  listCertifications,
};
