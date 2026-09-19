const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, uniqueEmail, loginReviewer, cleanupAssessment, cleanupPerson, pool } = require("../test-support/helpers");

let server, baseUrl, cookie;

// Заводит и полностью проходит проверку (тест + оба задания) для заданного
// context, возвращает { assessmentId, taskSubmissionIds }.
async function completeAssessment(context, emailPrefix) {
  const email = uniqueEmail(emailPrefix);
  const start = await fetch(`${baseUrl}/api/assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ standardCode: "06.032", context, person: { fullName: "Ревью Тестович", email } }),
  }).then((r) => r.json());
  const assessmentId = start.assessmentId;

  const quiz = await fetch(`${baseUrl}/api/assessments/${assessmentId}/quiz`).then((r) => r.json());
  const responses = quiz.map((q) => ({ questionId: q.id, selectedIndex: 0 }));
  await fetch(`${baseUrl}/api/assessments/${assessmentId}/quiz-responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ responses }),
  });

  const tasks = await fetch(`${baseUrl}/api/assessments/${assessmentId}/practical-task`).then((r) => r.json());
  const submissionIds = [];
  for (const t of tasks) {
    const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/practical-submission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: t.id, submissionText: "Ответ ревью-теста." }),
    }).then((r) => r.json());
    submissionIds.push(res.submissionId);
  }

  return { assessmentId, submissionIds, email };
}

const toCleanup = [];

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
  ({ cookie } = await loginReviewer(baseUrl));
});

test.after(async () => {
  for (const { assessmentId, email } of toCleanup) {
    await cleanupAssessment(assessmentId);
    await cleanupPerson(email);
  }
  await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
  server.close();
  await pool.end();
});

test("reviewer report shows the quiz score and unreviewed practical submissions", async () => {
  const { assessmentId, email } = await completeAssessment("candidate", "report");
  toCleanup.push({ assessmentId, email });

  const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/report`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const data = await res.json();
  // Варианты ответа перемешаны для каждой проверки индивидуально (см.
  // случайную выборку в backend/README.md), поэтому "все ответы на индекс 0"
  // даёт непредсказуемый %, а не гарантированный 0 — проверяем только форму.
  assert.equal(typeof data.summary.quizPercent, "number");
  assert.ok(data.summary.quizPercent >= 0 && data.summary.quizPercent <= 100);
  assert.equal(data.summary.allPracticalReviewed, false);
  assert.equal(data.practicalSubmissions.length, 2);
});

test("scoring a practical submission updates the report's summary", async () => {
  const { assessmentId, submissionIds, email } = await completeAssessment("candidate", "score");
  toCleanup.push({ assessmentId, email });

  for (const submissionId of submissionIds) {
    const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/practical-submissions/${submissionId}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ score: 80, notes: "автотест" }),
    });
    assert.equal(res.status, 200);
  }

  const report = await fetch(`${baseUrl}/api/assessments/${assessmentId}/report`, { headers: { Cookie: cookie } }).then(
    (r) => r.json()
  );
  assert.equal(report.summary.allPracticalReviewed, true);
  assert.equal(report.summary.practicalAverage, 80);
});

test("candidate decision endpoint accepts a valid decision", async () => {
  const { assessmentId, email } = await completeAssessment("candidate", "decision");
  toCleanup.push({ assessmentId, email });

  const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ decision: "accepted" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).decision, "accepted");
});

test("decision endpoint refuses an employee-context assessment", async () => {
  const { assessmentId, email } = await completeAssessment("employee", "employee-decision");
  toCleanup.push({ assessmentId, email });

  const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ decision: "accepted" }),
  });
  assert.equal(res.status, 400);
});

test("reviewer routes require a session even with a valid assessment id", async () => {
  const { assessmentId, email } = await completeAssessment("candidate", "noauth");
  toCleanup.push({ assessmentId, email });

  const res = await fetch(`${baseUrl}/api/assessments/${assessmentId}/report`);
  assert.equal(res.status, 401);
});
