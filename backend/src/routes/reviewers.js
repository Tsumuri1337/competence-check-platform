const db = require("../db");
const { logAccess } = require("../lib/accessLog");
const { resolveReviewerFromSession } = require("./auth");
const { decrypt } = require("../lib/pii");
const { listCertificates, osintView } = require("./people");
const { startOsintInBackground, latestRun } = require("../lib/osint");
const { computeScore } = require("../lib/scoring");
const { generateAiSummary, latestAiSummary, AiSummaryError } = require("../lib/aiSummary");

function decryptPerson(row) {
  return { ...row, full_name: decrypt(row.full_name), email: decrypt(row.email) };
}

async function requireReviewer(req, res) {
  const reviewer = await resolveReviewerFromSession(req);
  if (!reviewer) {
    res.status(401).json({ error: "Требуется вход (сессия истекла или отсутствует)" });
    return null;
  }
  return reviewer;
}

// GET /api/assessments?standardCode=&context=&status=
async function listAssessments(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;

  const { standardCode, context, status } = req.query;
  let sql = `
    SELECT a.id, a.status, a.context, a.decision, a.created_at, p.full_name, p.email, s.code as standard_code, s.title as standard_title,
      (SELECT count(*)::int FROM certificates c WHERE c.person_id = p.id AND c.status = 'verified') AS verified_certificates
    FROM assessments a
    JOIN people p ON p.id = a.person_id
    JOIN standards s ON s.id = a.standard_id
    WHERE 1=1
  `;
  const args = [];
  if (standardCode) {
    args.push(standardCode);
    sql += ` AND s.code = $${args.length}`;
  }
  if (context) {
    args.push(context);
    sql += ` AND a.context = $${args.length}`;
  }
  if (status) {
    args.push(status);
    sql += ` AND a.status = $${args.length}`;
  }
  sql += " ORDER BY a.created_at DESC";

  const { rows } = await db.query(sql, args);
  // Итоговый балл в списке — чтобы сортировать/сравнивать кандидатов, не
  // открывая каждый отчёт.
  const scores = await Promise.all(rows.map((r) => computeScore(r.id)));
  res.json(
    rows.map((r, i) => ({
      ...decryptPerson(r),
      score_total: scores[i] ? scores[i].total : null,
      score_provisional: scores[i] ? scores[i].provisional : true,
      score_grade: scores[i] && scores[i].grade ? scores[i].grade.title : null,
    }))
  );
}

// GET /api/assessments/:id/report — сводный отчёт: квиз + практическое
// задание + самооценка, сгруппированные по трудовым функциям.
async function getAssessmentReport(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;

  const assessmentId = Number(req.params.id);
  const assessmentResult = await db.query(
    `SELECT a.id, a.status, a.context, a.decision, a.created_at, p.id as person_id, p.full_name, p.email, p.phone, p.osint_username,
       s.id as standard_id, s.code as standard_code, s.title as standard_title
     FROM assessments a
     JOIN people p ON p.id = a.person_id
     JOIN standards s ON s.id = a.standard_id
     WHERE a.id = $1`,
    [assessmentId]
  );
  const assessmentRow = assessmentResult.rows[0];
  if (!assessmentRow) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }
  const assessment = decryptPerson(assessmentRow);
  assessment.phone = assessment.phone ? decrypt(assessment.phone) : null;
  assessment.osint_username = assessment.osint_username ? decrypt(assessment.osint_username) : null;

  const [quiz, submissions, ratings, certificates, osintRun, topicBreakdown, score, aiSummary] = await Promise.all([
    db.query(
      `SELECT qr.question_id, qr.selected_index, qr.is_correct, qq.text
       FROM quiz_responses qr JOIN quiz_questions qq ON qq.id = qr.question_id
       WHERE qr.assessment_id = $1 ORDER BY qq.id`,
      [assessmentId]
    ),
    db.query(
      `SELECT ps.id, ps.task_id, ps.submission_text, ps.reviewer_score, ps.reviewer_notes, ps.reviewed_at, pt.prompt, pt.rubric
       FROM practical_submissions ps JOIN practical_tasks pt ON pt.id = ps.task_id
       WHERE ps.assessment_id = $1 ORDER BY pt.id`,
      [assessmentId]
    ),
    db.query(
      `SELECT sar.competency_item_id, sar.rating, ci.kind, ci.text, lf.code as labor_function_code, lf.title as labor_function_title
       FROM self_assessment_ratings sar
       JOIN competency_items ci ON ci.id = sar.competency_item_id
       JOIN labor_functions lf ON lf.id = ci.labor_function_id
       WHERE sar.assessment_id = $1 ORDER BY lf.code, ci.id`,
      [assessmentId]
    ),
    listCertificates(assessment.person_id),
    latestRun(assessment.person_id),
    // Результат теста по темам требований (VPN, сети, криптография, ...) —
    // показывает, в каких областях пробелы, а не только общий процент.
    db.query(
      `SELECT t.slug, t.title, t.category_title, count(*)::int AS total, count(*) FILTER (WHERE qr.is_correct)::int AS correct
       FROM quiz_responses qr
       JOIN quiz_question_topics qt ON qt.quiz_question_id = qr.question_id
       JOIN topics t ON t.id = qt.topic_id
       WHERE qr.assessment_id = $1
       GROUP BY t.slug, t.title, t.category_title, t.sort_order
       ORDER BY t.sort_order`,
      [assessmentId]
    ),
    computeScore(assessmentId),
    latestAiSummary(assessmentId),
  ]);

  await logAccess(reviewer.id, assessmentId, "view_report");

  const quizCorrect = quiz.rows.filter((q) => q.is_correct).length;

  // Сводка для комплексного отчёта (используется в первую очередь для
  // решения по кандидату — см. reviewer_dashboard.html).
  const scoredSubmissions = submissions.rows.filter((s) => s.reviewer_score !== null);
  const practicalAverage = scoredSubmissions.length
    ? Math.round(scoredSubmissions.reduce((sum, s) => sum + s.reviewer_score, 0) / scoredSubmissions.length)
    : null;
  const summary = {
    quizPercent: quiz.rows.length ? Math.round((quizCorrect / quiz.rows.length) * 100) : null,
    practicalAverage,
    allPracticalReviewed: submissions.rows.length > 0 && scoredSubmissions.length === submissions.rows.length,
    selfAssessmentTaken: ratings.rows.length > 0,
    selfAssessmentAverage: ratings.rows.length
      ? Math.round((ratings.rows.reduce((sum, r) => sum + r.rating, 0) / ratings.rows.length) * 10) / 10
      : null,
  };

  res.json({
    assessment,
    quiz: { responses: quiz.rows, score: { correct: quizCorrect, total: quiz.rows.length } },
    practicalSubmissions: submissions.rows,
    selfAssessment: ratings.rows,
    summary,
    certificates,
    osint: osintView(osintRun),
    topicBreakdown: topicBreakdown.rows,
    score,
    aiSummary,
  });
}

// POST /api/assessments/:id/decision — решение по кандидату (найм/отказ).
// Сейчас применимо только к context='candidate'; для сотрудников не
// используется (см. backend/README.md).
// body: { decision: 'accepted' | 'rejected' | 'pending' }
async function setDecision(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;

  const assessmentId = Number(req.params.id);
  const { decision } = req.body || {};
  if (!["accepted", "rejected", "pending"].includes(decision)) {
    res.status(400).json({ error: "decision должен быть accepted | rejected | pending" });
    return;
  }

  const { rows } = await db.query("SELECT id, context FROM assessments WHERE id = $1", [assessmentId]);
  const assessment = rows[0];
  if (!assessment) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }
  if (assessment.context !== "candidate") {
    res.status(400).json({ error: "Решение по кандидату применимо только к проверкам с context=candidate" });
    return;
  }

  await db.query("UPDATE assessments SET decision = $1 WHERE id = $2", [decision, assessmentId]);
  await logAccess(reviewer.id, assessmentId, "set_decision");

  res.json({ assessmentId, decision });
}

// POST /api/assessments/:assessmentId/practical-submissions/:submissionId/score
// body: { score, notes }
async function scorePracticalSubmission(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;

  const submissionId = Number(req.params.submissionId);
  const { score, notes } = req.body || {};
  if (typeof score !== "number" || score < 0 || score > 100) {
    res.status(400).json({ error: "score должен быть числом от 0 до 100" });
    return;
  }

  const { rows } = await db.query("SELECT id, assessment_id FROM practical_submissions WHERE id = $1", [submissionId]);
  if (!rows[0]) {
    res.status(404).json({ error: "Submission не найден" });
    return;
  }

  await db.query(
    "UPDATE practical_submissions SET reviewer_id = $1, reviewer_score = $2, reviewer_notes = $3, reviewed_at = now() WHERE id = $4",
    [reviewer.id, score, notes || null, submissionId]
  );
  await logAccess(reviewer.id, rows[0].assessment_id, "score_submission");

  res.json({ submissionId, score, notes: notes || null });
}

async function personIdForAssessment(assessmentId) {
  const { rows } = await db.query("SELECT person_id FROM assessments WHERE id = $1", [assessmentId]);
  return rows[0] ? rows[0].person_id : null;
}

// POST /api/assessments/:id/osint — ревьюер перезапускает OSINT-поиск по
// человеку этой проверки (например, после того как кандидат дал никнейм).
async function rerunOsintForAssessment(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const assessmentId = Number(req.params.id);
  const personId = await personIdForAssessment(assessmentId);
  if (!personId) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }
  const running = await db.query("SELECT 1 FROM osint_runs WHERE person_id = $1 AND status = 'running' LIMIT 1", [personId]);
  if (running.rows[0]) {
    res.status(409).json({ error: "Поиск по этому человеку уже идёт" });
    return;
  }
  startOsintInBackground(personId, { trigger: "reviewer", reviewerId: reviewer.id });
  await logAccess(reviewer.id, assessmentId, "run_osint");
  res.status(202).json({ ok: true });
}

// POST /api/assessments/:id/certificates/:certId/review
// body: { status: 'verified' | 'rejected', note? } — ручное решение ревьюера
// (для вендоров без открытого API, «probable» и спорных бейджей). Повторный
// OSINT это решение не перетирает (см. reviewed_by в lib/osint).
async function reviewCertificate(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const assessmentId = Number(req.params.id);
  const { status, note } = req.body || {};
  if (!["verified", "rejected"].includes(status)) {
    res.status(400).json({ error: "status должен быть verified | rejected" });
    return;
  }
  const personId = await personIdForAssessment(assessmentId);
  const { rowCount } = await db.query(
    `UPDATE certificates SET status = $1, status_detail = $2, reviewed_by = $3, checked_at = now()
     WHERE id = $4 AND person_id = $5`,
    [
      status,
      `${status === "verified" ? "Подтверждён" : "Отклонён"} ревьюером ${reviewer.email}${note ? `: ${String(note).slice(0, 300)}` : ""}`,
      reviewer.id,
      Number(req.params.certId),
      personId,
    ]
  );
  if (!rowCount) {
    res.status(404).json({ error: "Сертификат не найден" });
    return;
  }
  await logAccess(reviewer.id, assessmentId, "review_certificate");
  res.json({ ok: true, status });
}

// POST /api/assessments/:id/ai-summary — сформировать AI-резюме кандидата
// (Claude; занимает до минуты). Каждый вызов — платный запрос к API, поэтому
// только по кнопке ревьюера, а не автоматически.
async function createAiSummary(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;
  const assessmentId = Number(req.params.id);
  try {
    const summary = await generateAiSummary(assessmentId, reviewer.id);
    await logAccess(reviewer.id, assessmentId, "ai_summary");
    res.status(201).json({ aiSummary: summary, score: await computeScore(assessmentId) });
  } catch (e) {
    if (e instanceof AiSummaryError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
}

module.exports = {
  createAiSummary,
  listAssessments,
  getAssessmentReport,
  scorePracticalSubmission,
  setDecision,
  rerunOsintForAssessment,
  reviewCertificate,
};
