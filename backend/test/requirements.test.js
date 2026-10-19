const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, pool } = require("../test-support/helpers");

let server, baseUrl;

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
});

test.after(async () => {
  server.close();
  await pool.end();
});

const get = (path) => fetch(`${baseUrl}${path}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test("GET /api/topics lists topics with per-standard counts", async () => {
  const { status, body } = await get("/api/topics");
  assert.equal(status, 200);
  const networks = body.find((t) => t.slug === "networks");
  assert.ok(networks.itemCount > 0);
  assert.ok(Object.keys(networks.standards).length >= 2);
  assert.ok(body.find((t) => t.slug === "vpn").certificationCount > 0);
});

test("GET /api/standards/:code/topics builds the topic index of a position", async () => {
  const { status, body } = await get("/api/standards/06.030/topics");
  assert.equal(status, 200);
  assert.ok(body.totalItems > 0);
  assert.ok(body.untaggedItems < body.totalItems * 0.15, "most items should fall under at least one topic");
  const topicSlugs = body.categories.flatMap((c) => c.topics.map((t) => t.slug));
  assert.ok(topicSlugs.includes("telecom"));
  assert.ok(body.certifications.length > 0);
  assert.equal((await get("/api/standards/99.999/topics")).status, 404);
});

test("GET /api/topics/:slug returns the competences and items requiring the topic", async () => {
  const { status, body } = await get("/api/topics/crypto");
  assert.equal(status, 200);
  assert.ok(body.standards.length > 0);
  const lf = body.standards[0].laborFunctions[0];
  assert.ok(lf.code && lf.title);
  assert.ok(lf.knowledge.length + lf.skills.length > 0);
  const filtered = await get("/api/topics/crypto?standard=06.032");
  assert.deepEqual(filtered.body.standards.map((s) => s.code), ["06.032"]);
});

test("competency item and labor function endpoints link skills, knowledge and competences", async () => {
  const search = await get(`/api/requirements/search?q=${encodeURIComponent("межсетев")}`);
  assert.equal(search.status, 200);
  const skill = search.body.items.find((i) => i.kind === "skill");
  assert.ok(skill, "search should find a firewall-related skill");

  const item = await get(`/api/competency-items/${skill.id}`);
  assert.equal(item.status, 200);
  assert.equal(item.body.kind, "skill");
  assert.ok(item.body.topics.some((t) => t.slug === "firewall"));
  assert.equal(item.body.laborFunction.id, skill.laborFunction.id);
  assert.ok(item.body.counterparts.every((c) => c.kind === "knowledge"));

  const lf = await get(`/api/labor-functions/${skill.laborFunction.id}`);
  assert.equal(lf.status, 200);
  assert.ok(lf.body.skills.some((s) => s.id === skill.id));
  assert.ok(lf.body.topics.length > 0);

  assert.equal((await get("/api/requirements/search?q=a")).status, 400);
});

test("GET /api/certifications returns the vendor catalog with topics and verification info", async () => {
  const { body } = await get("/api/certifications");
  const vendors = new Set(body.map((c) => c.vendor));
  for (const v of ["cisco", "huawei", "comptia", "isc2", "aws", "microsoft", "google-cloud", "offsec", "ec-council", "hackthebox"]) {
    assert.ok(vendors.has(v), `catalog should include ${v}`);
  }
  for (const c of body) assert.ok(c.topics.length > 0 && c.verify && c.verify.url);
});

test("every topic referenced by the certification catalog exists in topics.json", () => {
  const { loadTopics } = require("../src/lib/topics");
  const { certifications } = require("../src/lib/certifications");
  const known = new Set(loadTopics().topics.map((t) => t.slug));
  for (const c of certifications) for (const t of c.topics) assert.ok(known.has(t), `${c.id}: unknown topic ${t}`);
});

// Покрытие тематического индекса: если правила в topics.json перестанут
// находить темы для вопросов теста или пунктов стандартов (новые вопросы,
// правка правил), тест упадёт, а не тихо выпадут области из вкладки
// «Требования» и из разбивки результатов по темам.
const MIN_TOPIC_COVERAGE = 0.95;

test(`at least ${MIN_TOPIC_COVERAGE * 100}% of quiz questions and of knowledge/skill items have a topic`, async () => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM quiz_questions)::int AS questions,
      (SELECT count(DISTINCT quiz_question_id) FROM quiz_question_topics)::int AS tagged_questions,
      (SELECT count(*) FROM competency_items)::int AS items,
      (SELECT count(DISTINCT competency_item_id) FROM competency_item_topics)::int AS tagged_items`);
  const r = rows[0];
  assert.ok(r.tagged_questions / r.questions >= MIN_TOPIC_COVERAGE, `questions with a topic: ${r.tagged_questions}/${r.questions}`);
  assert.ok(r.tagged_items / r.items >= MIN_TOPIC_COVERAGE, `items with a topic: ${r.tagged_items}/${r.items}`);
});

test("every topic is used by the standards or by the test — no empty topics", async () => {
  const { rows } = await pool.query(`
    SELECT t.slug FROM topics t
    WHERE NOT EXISTS (SELECT 1 FROM competency_item_topics x WHERE x.topic_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM quiz_question_topics x WHERE x.topic_id = t.id)`);
  assert.deepEqual(rows.map((r) => r.slug), []);
});

test("every competence (labor function) has knowledge/skill items and at least one quiz question", async () => {
  const { rows } = await pool.query(`
    SELECT lf.code FROM labor_functions lf
    WHERE NOT EXISTS (SELECT 1 FROM competency_items ci WHERE ci.labor_function_id = lf.id)
       OR NOT EXISTS (SELECT 1 FROM quiz_questions q WHERE q.labor_function_id = lf.id)`);
  assert.deepEqual(rows.map((r) => r.code), []);
});
