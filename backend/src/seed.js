const fs = require("fs");
const path = require("path");
const { query, pool } = require("./db");
const { hashPassword } = require("./lib/auth");
const { loadTopics, matchTopics } = require("./lib/topics");
const { encrypt, emailBlindIndex } = require("./lib/pii");

const CONTENT_DIR = path.join(__dirname, "content");

// Транскрибировано вручную из официальных PDF профстандартов (см.
// backend/README.md) — визуальным чтением отрендеренных страниц, не через
// автоматическую суммаризацию (которая на этих документах галлюцинирует).
const STANDARD_FILES = ["06.030", "06.032", "06.033", "06.034", "06.053"];

async function loadStandard(code) {
  const dataPath = path.join(CONTENT_DIR, `${code}.json`);
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

  const existing = await query("SELECT id FROM standards WHERE code = $1", [data.code]);
  if (existing.rows[0]) {
    console.log(`${code}: already loaded, skipping`);
    return;
  }

  const standardResult = await query(
    "INSERT INTO standards (code, title, order_ref, source_url) VALUES ($1, $2, $3, $4) RETURNING id",
    [data.code, data.title, data.order, data.sourceUrl || null]
  );
  const standardId = standardResult.rows[0].id;

  const laborFunctionIds = new Map(); // code -> id, used by quiz/task loader below

  for (const gf of data.generalized_functions) {
    const gfResult = await query(
      "INSERT INTO generalized_functions (standard_id, code, title, qualification_level) VALUES ($1, $2, $3, $4) RETURNING id",
      [standardId, gf.code, gf.title, gf.qualification_level]
    );
    const gfId = gfResult.rows[0].id;

    for (const lf of gf.labor_functions) {
      const lfResult = await query(
        "INSERT INTO labor_functions (generalized_function_id, code, title) VALUES ($1, $2, $3) RETURNING id",
        [gfId, lf.code, lf.title]
      );
      const lfId = lfResult.rows[0].id;
      laborFunctionIds.set(lf.code, lfId);

      for (const k of lf.knowledge) {
        await query("INSERT INTO competency_items (labor_function_id, kind, text) VALUES ($1, 'knowledge', $2)", [lfId, k]);
      }
      for (const s of lf.skills) {
        await query("INSERT INTO competency_items (labor_function_id, kind, text) VALUES ($1, 'skill', $2)", [lfId, s]);
      }
    }
  }

  console.log(`${code}: loaded ${data.generalized_functions.length} ОТФ`);

  // Авторский тестовый контент (вопросы теста знаний + практические
  // задания) — составлен на основе транскрибированных знаний/умений, а не
  // цитаты из стандарта. Хранится отдельно от самого стандарта.
  const testContentPath = path.join(CONTENT_DIR, `${code}.test.json`);
  if (fs.existsSync(testContentPath)) {
    const testContent = JSON.parse(fs.readFileSync(testContentPath, "utf8"));

    for (const q of testContent.questions || []) {
      const laborFunctionId = q.laborFunctionCode ? laborFunctionIds.get(q.laborFunctionCode) : null;
      await query(
        "INSERT INTO quiz_questions (standard_id, labor_function_id, text, options, correct_index) VALUES ($1, $2, $3, $4, $5)",
        [standardId, laborFunctionId || null, q.text, JSON.stringify(q.options), q.correctIndex]
      );
    }
    for (const t of testContent.tasks || []) {
      const laborFunctionId = t.laborFunctionCode ? laborFunctionIds.get(t.laborFunctionCode) : null;
      await query(
        "INSERT INTO practical_tasks (standard_id, labor_function_id, prompt, rubric) VALUES ($1, $2, $3, $4)",
        [standardId, laborFunctionId || null, t.prompt, t.rubric]
      );
    }
    console.log(`${code}: loaded ${(testContent.questions || []).length} quiz questions, ${(testContent.tasks || []).length} practical tasks`);
  } else {
    console.log(`${code}: no test content file found (${testContentPath}) — quiz/practical task will be empty`);
  }
}

async function upsertReviewer(fullName, email, role, password) {
  const existing = await query("SELECT id, password_hash FROM reviewers WHERE email = $1", [email]);
  if (existing.rows[0]) {
    // Реестр уже существует (например, после старой миграции без паролей) —
    // проставляем пароль, только если его ещё нет, не трогаем остальное.
    if (!existing.rows[0].password_hash) {
      await query("UPDATE reviewers SET password_hash = $1 WHERE id = $2", [hashPassword(password), existing.rows[0].id]);
    }
    return existing.rows[0].id;
  }
  const inserted = await query(
    "INSERT INTO reviewers (full_name, email, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id",
    [fullName, email, role, hashPassword(password)]
  );
  return inserted.rows[0].id;
}

// Тематический индекс — производные данные: каждый запуск пересобирает
// темы и их привязку к пунктам знаний/умений и вопросам теста по правилам из
// content/topics.json, поэтому правка правил применяется повторным `npm run seed`.
async function seedTopics() {
  const { categories, topics } = loadTopics();
  const categoryTitle = new Map(categories.map((c) => [c.slug, c.title]));
  const categoryOrder = new Map(categories.map((c, i) => [c.slug, i]));
  await query("DELETE FROM competency_item_topics");
  await query("DELETE FROM quiz_question_topics");
  const slugs = topics.map((t) => t.slug);
  await query("DELETE FROM topics WHERE NOT (slug = ANY($1))", [slugs]);

  const topicIds = new Map();
  for (const [i, t] of topics.entries()) {
    const { rows } = await query(
      `INSERT INTO topics (slug, category, category_title, title, title_en, description, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET category = $2, category_title = $3, title = $4, title_en = $5, description = $6, sort_order = $7
       RETURNING id`,
      [t.slug, t.category, categoryTitle.get(t.category), t.title, t.titleEn || null, t.description || null, categoryOrder.get(t.category) * 100 + i]
    );
    topicIds.set(t.slug, rows[0].id);
  }

  async function tag(table, column, rows) {
    const pairs = [];
    for (const r of rows) for (const slug of matchTopics(r.text, topics)) pairs.push([r.id, topicIds.get(slug)]);
    for (let i = 0; i < pairs.length; i += 1000) {
      const chunk = pairs.slice(i, i + 1000);
      await query(
        `INSERT INTO ${table} (${column}, topic_id) SELECT * FROM unnest($1::int[], $2::int[])`,
        [chunk.map((p) => p[0]), chunk.map((p) => p[1])]
      );
    }
    return pairs.length;
  }
  const items = await query("SELECT id, text FROM competency_items");
  const questions = await query("SELECT id, text FROM quiz_questions");
  const itemLinks = await tag("competency_item_topics", "competency_item_id", items.rows);
  const questionLinks = await tag("quiz_question_topics", "quiz_question_id", questions.rows);
  console.log(`Темы: ${topics.length}, связей со знаниями/умениями: ${itemLinks}, с вопросами теста: ${questionLinks}`);
}

// Демо-кандидат для ручной проверки личного кабинета (только если такого
// email ещё нет — существующую запись не трогаем).
async function upsertDemoPerson() {
  const email = "candidate@example.ru";
  const existing = await query("SELECT id FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
  if (existing.rows[0]) return;
  await query(
    `INSERT INTO people (full_name, email, email_hash, phone, password_hash, context, osint_consent_at)
     VALUES ($1, $2, $3, $4, $5, 'candidate', now())`,
    [encrypt("Демо Кандидат"), encrypt(email), emailBlindIndex(email), encrypt("+79000000000"), hashPassword("candidate123")]
  );
}

async function seed() {
  for (const code of STANDARD_FILES) {
    await loadStandard(code);
  }
  await seedTopics();
  await upsertReviewer("А. Ревьюер", "reviewer@example.ru", "reviewer", "reviewer123");
  await upsertDemoPerson();
  console.log("Seed complete. Демо-ревьюер: reviewer@example.ru / reviewer123, демо-кандидат: candidate@example.ru / candidate123");
}

seed()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
