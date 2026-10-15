const db = require("../db");

// Предметный индекс компетенций — см. src/content/competences.json и
// src/lib/competences.js. Все эндпоинты открытые: это справочные данные
// из профстандартов, ПДн здесь нет.

// GET /api/competences
// Все области с числом пунктов знаний/умений в каждом профстандарте.
async function listCompetences(req, res) {
  const { rows: competences } = await db.query("SELECT id, slug, title, description FROM competences ORDER BY position, id");
  const { rows: counts } = await db.query(
    `SELECT cmi.competence_id, s.code, s.title,
            count(*) FILTER (WHERE ci.kind = 'knowledge')::int AS knowledge,
            count(*) FILTER (WHERE ci.kind = 'skill')::int AS skills
     FROM competence_items cmi
     JOIN competency_items ci ON ci.id = cmi.competency_item_id
     JOIN labor_functions lf ON lf.id = ci.labor_function_id
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     JOIN standards s ON s.id = gf.standard_id
     GROUP BY cmi.competence_id, s.code, s.title
     ORDER BY s.code`
  );
  const byCompetence = new Map();
  for (const r of counts) {
    if (!byCompetence.has(r.competence_id)) byCompetence.set(r.competence_id, []);
    byCompetence.get(r.competence_id).push({ code: r.code, title: r.title, knowledge: r.knowledge, skills: r.skills });
  }
  res.json(
    competences.map((c) => ({
      slug: c.slug,
      title: c.title,
      description: c.description,
      standards: byCompetence.get(c.id) || [],
    }))
  );
}

// GET /api/competences/:slug?standardCode=06.032
// Что нужно знать и уметь для этой области: по каждому профстандарту
// (или только по указанному) — ТФ и их пункты знаний/умений.
async function getCompetence(req, res) {
  const { slug } = req.params;
  const { standardCode } = req.query;
  const { rows } = await db.query("SELECT id, slug, title, description FROM competences WHERE slug = $1", [slug]);
  const competence = rows[0];
  if (!competence) {
    res.status(404).json({ error: "Компетенция не найдена" });
    return;
  }

  const params = [competence.id];
  let standardFilter = "";
  if (standardCode) {
    params.push(standardCode);
    standardFilter = "AND s.code = $2";
  }
  const { rows: items } = await db.query(
    `SELECT ci.id, ci.kind, ci.text,
            lf.code AS lf_code, lf.title AS lf_title,
            gf.code AS gf_code, gf.title AS gf_title, gf.qualification_level,
            s.code AS standard_code, s.title AS standard_title
     FROM competence_items cmi
     JOIN competency_items ci ON ci.id = cmi.competency_item_id
     JOIN labor_functions lf ON lf.id = ci.labor_function_id
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     JOIN standards s ON s.id = gf.standard_id
     WHERE cmi.competence_id = $1 ${standardFilter}
     ORDER BY s.code, lf.code, ci.id`,
    params
  );

  const standards = [];
  for (const it of items) {
    let standard = standards[standards.length - 1];
    if (!standard || standard.code !== it.standard_code) {
      standard = { code: it.standard_code, title: it.standard_title, laborFunctions: [] };
      standards.push(standard);
    }
    let lf = standard.laborFunctions[standard.laborFunctions.length - 1];
    if (!lf || lf.code !== it.lf_code) {
      lf = {
        code: it.lf_code,
        title: it.lf_title,
        generalizedFunction: { code: it.gf_code, title: it.gf_title, qualificationLevel: it.qualification_level },
        knowledge: [],
        skills: [],
      };
      standard.laborFunctions.push(lf);
    }
    (it.kind === "knowledge" ? lf.knowledge : lf.skills).push({ id: it.id, text: it.text });
  }

  res.json({ slug: competence.slug, title: competence.title, description: competence.description, standards });
}

// GET /api/standards/:code/competences
// Профиль профессии: какие области компетенций требует стандарт, сколько
// в каждой пунктов, в каких ТФ и на каких уровнях квалификации они
// встречаются. Сами пункты — через /api/competences/:slug?standardCode=.
async function getStandardCompetences(req, res) {
  const { code } = req.params;
  const { rows: standardRows } = await db.query("SELECT id, code, title FROM standards WHERE code = $1", [code]);
  const standard = standardRows[0];
  if (!standard) {
    res.status(404).json({ error: "Профстандарт не найден" });
    return;
  }
  const { rows } = await db.query(
    `SELECT c.slug, c.title, c.description,
            count(*) FILTER (WHERE ci.kind = 'knowledge')::int AS knowledge,
            count(*) FILTER (WHERE ci.kind = 'skill')::int AS skills,
            array_agg(DISTINCT lf.code ORDER BY lf.code) AS labor_functions,
            array_agg(DISTINCT gf.qualification_level ORDER BY gf.qualification_level) AS qualification_levels
     FROM competences c
     JOIN competence_items cmi ON cmi.competence_id = c.id
     JOIN competency_items ci ON ci.id = cmi.competency_item_id
     JOIN labor_functions lf ON lf.id = ci.labor_function_id
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     WHERE gf.standard_id = $1
     GROUP BY c.id
     ORDER BY count(*) DESC, c.position`,
    [standard.id]
  );
  res.json({
    code: standard.code,
    title: standard.title,
    competences: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      knowledge: r.knowledge,
      skills: r.skills,
      laborFunctions: r.labor_functions,
      qualificationLevels: r.qualification_levels,
    })),
  });
}

module.exports = { listCompetences, getCompetence, getStandardCompetences };
