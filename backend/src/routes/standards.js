const db = require("../db");

// GET /api/standards
async function listStandards(req, res) {
  const { rows } = await db.query("SELECT id, code, title, order_ref FROM standards ORDER BY code");
  res.json(rows);
}

// GET /api/standards/:code
// Полное дерево: ОТФ -> ТФ -> знания/умения. Источник истины для
// self-assessment и для отображения структуры проверки кандидату/сотруднику.
async function getStandardByCode(req, res) {
  const { code } = req.params;
  const standardResult = await db.query(
    "SELECT id, code, title, order_ref, source_url FROM standards WHERE code = $1",
    [code]
  );
  const standard = standardResult.rows[0];
  if (!standard) {
    res.status(404).json({ error: "Профстандарт не найден" });
    return;
  }

  const gfResult = await db.query(
    "SELECT id, code, title, qualification_level FROM generalized_functions WHERE standard_id = $1 ORDER BY code",
    [standard.id]
  );
  const lfResult = await db.query(
    `SELECT lf.id, lf.generalized_function_id, lf.code, lf.title
     FROM labor_functions lf
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     WHERE gf.standard_id = $1
     ORDER BY lf.code`,
    [standard.id]
  );
  const itemsResult = await db.query(
    `SELECT ci.id, ci.labor_function_id, ci.kind, ci.text
     FROM competency_items ci
     JOIN labor_functions lf ON lf.id = ci.labor_function_id
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     WHERE gf.standard_id = $1
     ORDER BY ci.id`,
    [standard.id]
  );

  const itemsByLaborFunction = new Map();
  for (const item of itemsResult.rows) {
    if (!itemsByLaborFunction.has(item.labor_function_id)) itemsByLaborFunction.set(item.labor_function_id, []);
    itemsByLaborFunction.get(item.labor_function_id).push(item);
  }

  const laborFunctionsByGf = new Map();
  for (const lf of lfResult.rows) {
    const items = itemsByLaborFunction.get(lf.id) || [];
    const laborFunction = {
      id: lf.id,
      code: lf.code,
      title: lf.title,
      knowledge: items.filter((i) => i.kind === "knowledge").map((i) => ({ id: i.id, text: i.text })),
      skills: items.filter((i) => i.kind === "skill").map((i) => ({ id: i.id, text: i.text })),
    };
    if (!laborFunctionsByGf.has(lf.generalized_function_id)) laborFunctionsByGf.set(lf.generalized_function_id, []);
    laborFunctionsByGf.get(lf.generalized_function_id).push(laborFunction);
  }

  const generalizedFunctions = gfResult.rows.map((gf) => ({
    id: gf.id,
    code: gf.code,
    title: gf.title,
    qualificationLevel: gf.qualification_level,
    laborFunctions: laborFunctionsByGf.get(gf.id) || [],
  }));

  res.json({
    id: standard.id,
    code: standard.code,
    title: standard.title,
    orderRef: standard.order_ref,
    sourceUrl: standard.source_url,
    generalizedFunctions,
  });
}

module.exports = { listStandards, getStandardByCode };
