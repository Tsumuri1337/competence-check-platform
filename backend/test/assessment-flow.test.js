const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, uniqueEmail, cleanupAssessment, cleanupPerson, pool } = require("../test-support/helpers");

let server, baseUrl;
const email = uniqueEmail("flow");
let assessmentId;

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
});

test.after(async () => {
  if (assessmentId) await cleanupAssessment(assessmentId);
  await cleanupPerson(email);
  server.close();
  await pool.end();
});

test("POST /api/assessments starts a new assessment", async () => {
  const res = await fetch(`${baseUrl}/api/assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      standardCode: "06.030",
      context: "candidate",
      person: { fullName: "Тестовый Кандидат", email },
    }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.status, "in_progress");
  assert.ok(Number.isInteger(data.assessmentId));
  assessmentId = data.assessmentId;
});

test("GET /api/assessments/:id/quiz draws exactly 50 questions and hides the correct answer", async () => {
  const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/quiz`);
  assert.equal(res.status, 200);
  const quiz = await res.json();
  assert.equal(quiz.length, 50);
  for (const q of quiz) {
    assert.equal(q.options.length, 4);
    assert.equal("correctIndex" in q, false);
    assert.equal("correct_index" in q, false);
  }
});

test("GET /api/assessments/:id/quiz is stable across repeated calls (persisted assignment)", async () => {
  const [res1, res2] = await Promise.all([
    fetch(`${baseUrl}/api/assessments/${assessmentId}/quiz`),
    fetch(`${baseUrl}/api/assessments/${assessmentId}/quiz`),
  ]);
  const [quiz1, quiz2] = await Promise.all([res1.json(), res2.json()]);
  assert.deepEqual(quiz1, quiz2);
});

test("submitting the canonically-correct answer for every question scores 50/50 through the shuffled option order", async () => {
  const { rows } = await pool.query("SELECT quiz_assignment FROM assessments WHERE id = $1", [assessmentId]);
  const assignment = rows[0].quiz_assignment;
  const questionIds = assignment.map((a) => a.questionId);
  const { rows: questionRows } = await pool.query("SELECT id, correct_index FROM quiz_questions WHERE id = ANY($1)", [
    questionIds,
  ]);
  const correctById = new Map(questionRows.map((r) => [r.id, r.correct_index]));

  const responses = assignment.map((a) => {
    const canonicalCorrect = correctById.get(a.questionId);
    const presentedIndex = a.optionOrder.indexOf(canonicalCorrect);
    return { questionId: a.questionId, selectedIndex: presentedIndex };
  });

  const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/quiz-responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ responses }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.correctCount, 50);
  assert.equal(data.total, 50);
});

let taskIds = [];

test("GET /api/assessments/:id/practical-task draws exactly 2 tasks", async () => {
  const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/practical-task`);
  assert.equal(res.status, 200);
  const tasks = await res.json();
  assert.equal(tasks.length, 2);
  taskIds = tasks.map((t) => t.id);
});

test("assessment only completes once every ASSIGNED task (not the whole bank) has a submission", async () => {
  const before = await fetch(`${baseUrl}/api/assessments/${assessmentId}`).then((r) => r.json());
  assert.equal(before.status, "in_progress");

  const first = await fetch(`${baseUrl}/api/assessments/${assessmentId}/practical-submission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: taskIds[0], submissionText: "Первое задание, автотест." }),
  });
  assert.equal(first.status, 201);

  const mid = await fetch(`${baseUrl}/api/assessments/${assessmentId}`).then((r) => r.json());
  assert.equal(mid.status, "in_progress", "should not complete after only 1 of 2 assigned tasks");

  const second = await fetch(`${baseUrl}/api/assessments/${assessmentId}/practical-submission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: taskIds[1], submissionText: "Второе задание, автотест." }),
  });
  assert.equal(second.status, 201);

  const after = await fetch(`${baseUrl}/api/assessments/${assessmentId}`).then((r) => r.json());
  assert.equal(after.status, "completed");
});
