const db = require("../db");
const { logAccess } = require("../lib/accessLog");
const { resolveReviewerFromSession } = require("./auth");
const { decrypt } = require("../lib/pii");

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
    SELECT a.id, a.status, a.context, a.decision, a.created_at, p.full_name, p.email, s.code as standard_code, s.title as standard_title
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
  res.json(rows.map(decryptPerson));
}

// GET /api/assessments/:id/report — сводный отчёт: квиз + практическое
// задание + самооценка, сгруппированные по трудовым функциям.
async function getAssessmentReport(req, res) {
  const reviewer = await requireReviewer(req, res);
  if (!reviewer) return;

  const assessmentId = Number(req.params.id);
  const assessmentResult = await db.query(
    `SELECT a.id, a.status, a.context, a.decision, a.created_at, p.full_name, p.email, s.id as standard_id, s.code as standard_code, s.title as standard_title
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

  const [quiz, submissions, ratings] = await Promise.all([
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

module.exports = { listAssessments, getAssessmentReport, scorePracticalSubmission, setDecision };
