const db = require("../db");
const { requirePerson } = require("./people");

// Каждая проверка получает случайную выборку из общего банка вопросов/
// заданий — выбирается один раз и сохраняется в assessments.quiz_assignment
// / task_assignment, чтобы обновление страницы или восстановление
// прогресса показывало тот же набор в том же порядке, а не новую выборку.
const QUIZ_SIZE = 50;
const TASK_COUNT = 2;

function shuffle(array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Проверка принадлежит вошедшему кандидату/сотруднику — раньше любой, кто
// знал id, мог читать вопросы и отправлять ответы за другого человека.
// Чужая проверка отвечает 404 (а не 403), чтобы не подтверждать её существование.
async function loadOwnedAssessment(req, res, columns) {
  const person = await requirePerson(req, res);
  if (!person) return null;
  const { rows } = await db.query(`SELECT ${columns}, person_id FROM assessments WHERE id = $1`, [Number(req.params.id)]);
  const assessment = rows[0];
  if (!assessment || assessment.person_id !== person.id) {
    res.status(404).json({ error: "Проверка не найдена" });
    return null;
  }
  return assessment;
}

async function ensureQuizAssignment(assessment) {
  if (assessment.quiz_assignment) return assessment.quiz_assignment;
  const { rows } = await db.query("SELECT id FROM quiz_questions WHERE standard_id = $1", [assessment.standard_id]);
  const questionIds = shuffle(rows.map((r) => r.id)).slice(0, QUIZ_SIZE);
  const assignment = questionIds.map((questionId) => ({ questionId, optionOrder: shuffle([0, 1, 2, 3]) }));
  // quiz_started_at — верхняя граница суммарного времени ответов (см. submitQuizResponses).
  await db.query("UPDATE assessments SET quiz_assignment = $1, quiz_started_at = now() WHERE id = $2", [
    JSON.stringify(assignment),
    assessment.id,
  ]);
  return assignment;
}

async function ensureTaskAssignment(assessment) {
  if (assessment.task_assignment) return assessment.task_assignment;
  const { rows } = await db.query("SELECT id FROM practical_tasks WHERE standard_id = $1", [assessment.standard_id]);
  const assignment = shuffle(rows.map((r) => r.id)).slice(0, TASK_COUNT);
  await db.query("UPDATE assessments SET task_assignment = $1 WHERE id = $2", [JSON.stringify(assignment), assessment.id]);
  return assignment;
}

// POST /api/assessments  body: { standardCode }
// Человек и контекст (кандидат/сотрудник) берутся из сессии личного
// кабинета (routes/people.js), а не из тела запроса.
async function startAssessment(req, res) {
  const person = await requirePerson(req, res);
  if (!person) return;
  const { standardCode } = req.body || {};
  if (!standardCode) {
    res.status(400).json({ error: "standardCode обязателен" });
    return;
  }

  const standardResult = await db.query("SELECT id FROM standards WHERE code = $1", [standardCode]);
  const standard = standardResult.rows[0];
  if (!standard) {
    res.status(404).json({ error: "Профстандарт не найден" });
    return;
  }

  const { rows } = await db.query(
    "INSERT INTO assessments (person_id, standard_id, context) VALUES ($1, $2, $3) RETURNING id",
    [person.id, standard.id, person.context]
  );
  res.status(201).json({ assessmentId: rows[0].id, status: "in_progress" });
}

// GET /api/assessments/:id — статус своей проверки (ПДн здесь не отдаются,
// профиль — в /api/people/me, полный отчёт — у ревьюера в /report).
async function getAssessment(req, res) {
  const owned = await loadOwnedAssessment(req, res, "id");
  if (!owned) return;
  const { rows } = await db.query(
    `SELECT a.id, a.status, a.context, a.created_at, s.code as standard_code, s.title as standard_title
     FROM assessments a
     JOIN standards s ON s.id = a.standard_id
     WHERE a.id = $1`,
    [owned.id]
  );
  res.json(rows[0]);
}

// GET /api/assessments/:id/quiz — случайная выборка из банка вопросов
// (см. ensureQuizAssignment), без правильных ответов, с вариантами в
// перемешанном для этой проверки порядке.
async function getQuiz(req, res) {
  const assessment = await loadOwnedAssessment(req, res, "id, standard_id, quiz_assignment");
  if (!assessment) return;
  const assignment = await ensureQuizAssignment(assessment);

  const { rows } = await db.query("SELECT id, text, options FROM quiz_questions WHERE id = ANY($1)", [
    assignment.map((a) => a.questionId),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const result = assignment.map(({ questionId, optionOrder }) => {
    const q = byId.get(questionId);
    return { id: q.id, text: q.text, options: optionOrder.map((i) => q.options[i]) };
  });
  res.json(result);
}

// Время ответа приходит от клиента (сколько вопрос был на экране), поэтому
// сервер его ограничивает: не больше MAX_ANSWER_MS на вопрос, а сумма — не
// больше реально прошедшего с выдачи теста (иначе пропорционально ужимается).
const MAX_ANSWER_MS = 10 * 60 * 1000;

function sanitizeTimes(responses, startedAt) {
  const times = responses.map((r) =>
    Number.isFinite(r.timeMs) && r.timeMs >= 0 ? Math.min(Math.round(r.timeMs), MAX_ANSWER_MS) : null
  );
  const known = times.filter((t) => t !== null);
  if (!known.length || !startedAt) return times;
  const elapsed = Date.now() - new Date(startedAt).getTime() + 5000;
  const sum = known.reduce((a, b) => a + b, 0);
  if (sum <= elapsed) return times;
  const k = elapsed / sum;
  return times.map((t) => (t === null ? null : Math.round(t * k)));
}

// POST /api/assessments/:id/quiz-responses
// body: { responses: [{ questionId, selectedIndex, timeMs? }] } — selectedIndex is
// relative to the shuffled options this assessment was shown; translated
// back to the question's canonical option order before scoring/storing.
// Отправить ответы можно один раз: результат кандидат видит сразу, и
// повторная отправка позволила бы «исправить» неверные ответы.
async function submitQuizResponses(req, res) {
  const assessmentId = Number(req.params.id);
  const { responses } = req.body || {};
  if (!Array.isArray(responses) || responses.length === 0) {
    res.status(400).json({ error: "responses обязателен и должен быть непустым массивом" });
    return;
  }

  const assessment = await loadOwnedAssessment(req, res, "id, quiz_assignment, quiz_started_at, quiz_submitted_at");
  if (!assessment) return;
  if (assessment.quiz_submitted_at) {
    res.status(409).json({ error: "Ответы теста уже отправлены — изменить их нельзя" });
    return;
  }
  const times = sanitizeTimes(responses, assessment.quiz_started_at);
  const optionOrderByQuestion = new Map((assessment.quiz_assignment || []).map((a) => [a.questionId, a.optionOrder]));

  const score = await db.transaction(async (client) => {
    // Блокировка строки — две одновременные отправки не пройдут обе.
    const locked = await client.query("SELECT quiz_submitted_at FROM assessments WHERE id = $1 FOR UPDATE", [assessmentId]);
    if (locked.rows[0].quiz_submitted_at) return null;
    let correctCount = 0;
    for (const [i, r] of responses.entries()) {
      const optionOrder = optionOrderByQuestion.get(r.questionId);
      if (!optionOrder) continue; // вопрос не входит в выборку этой проверки
      const canonicalIndex = optionOrder[r.selectedIndex];
      const qResult = await client.query("SELECT correct_index FROM quiz_questions WHERE id = $1", [r.questionId]);
      const question = qResult.rows[0];
      if (!question) continue;
      const isCorrect = question.correct_index === canonicalIndex;
      if (isCorrect) correctCount += 1;
      await client.query(
        `INSERT INTO quiz_responses (assessment_id, question_id, selected_index, is_correct, time_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (assessment_id, question_id) DO UPDATE SET selected_index = $3, is_correct = $4, time_ms = $5`,
        [assessmentId, r.questionId, canonicalIndex, isCorrect, times[i]]
      );
    }
    await client.query("UPDATE assessments SET quiz_submitted_at = now() WHERE id = $1", [assessmentId]);
    return { correctCount, total: responses.length };
  });
  if (!score) {
    res.status(409).json({ error: "Ответы теста уже отправлены — изменить их нельзя" });
    return;
  }

  res.json({ assessmentId, ...score });
}

// GET /api/assessments/:id/practical-task — случайная выборка из банка
// заданий (см. ensureTaskAssignment).
async function getPracticalTask(req, res) {
  const assessment = await loadOwnedAssessment(req, res, "id, standard_id, task_assignment");
  if (!assessment) return;
  const taskIds = await ensureTaskAssignment(assessment);

  const { rows } = await db.query("SELECT id, prompt FROM practical_tasks WHERE id = ANY($1)", [taskIds]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  res.json(taskIds.map((id) => byId.get(id)));
}

// POST /api/assessments/:id/practical-submission
// body: { taskId, submissionText } — completes the assessment once every
// task ASSIGNED to this assessment (see ensureTaskAssignment, not every
// task in the standard's whole bank) has a submission. Quiz is required
// first; self-assessment is optional and doesn't gate completion.
async function submitPracticalSubmission(req, res) {
  const assessmentId = Number(req.params.id);
  const { taskId, submissionText } = req.body || {};
  if (!taskId || !submissionText) {
    res.status(400).json({ error: "taskId и submissionText обязательны" });
    return;
  }

  const assessment = await loadOwnedAssessment(req, res, "id, standard_id, task_assignment");
  if (!assessment) return;
  const assignedTaskIds = await ensureTaskAssignment(assessment);
  const reviewed = await db.query(
    "SELECT 1 FROM practical_submissions WHERE assessment_id = $1 AND task_id = $2 AND reviewer_score IS NOT NULL",
    [assessmentId, taskId]
  );
  if (reviewed.rows[0]) {
    res.status(409).json({ error: "Решение уже оценено ревьюером — изменить его нельзя" });
    return;
  }

  const submissionId = await db.transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO practical_submissions (assessment_id, task_id, submission_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (assessment_id, task_id) DO UPDATE SET submission_text = $3, submitted_at = now()
       RETURNING id`,
      [assessmentId, taskId, submissionText]
    );

    const totalSubmissions = await client.query(
      "SELECT count(*) FROM practical_submissions WHERE assessment_id = $1 AND task_id = ANY($2)",
      [assessmentId, assignedTaskIds]
    );
    if (Number(totalSubmissions.rows[0].count) >= assignedTaskIds.length) {
      await client.query("UPDATE assessments SET status = 'completed' WHERE id = $1", [assessmentId]);
    }

    return inserted.rows[0].id;
  });

  res.status(201).json({ submissionId });
}

// GET /api/assessments/:id/self-assessment — пункты для оценки, сгруппированные по ТФ
async function getSelfAssessmentItems(req, res) {
  const assessment = await loadOwnedAssessment(req, res, "standard_id");
  if (!assessment) return;
  const { rows } = await db.query(
    `SELECT ci.id, ci.kind, ci.text, lf.code as labor_function_code, lf.title as labor_function_title
     FROM competency_items ci
     JOIN labor_functions lf ON lf.id = ci.labor_function_id
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     WHERE gf.standard_id = $1
     ORDER BY lf.code, ci.id`,
    [assessment.standard_id]
  );
  res.json(rows);
}

// POST /api/assessments/:id/self-assessment
// body: { ratings: [{ competencyItemId, rating }] }
// Self-assessment is optional and informational only — it does not gate or
// set the assessment's completion status (see submitPracticalSubmission).
async function submitSelfAssessment(req, res) {
  const assessmentId = Number(req.params.id);
  const { ratings } = req.body || {};
  if (!Array.isArray(ratings) || ratings.length === 0) {
    res.status(400).json({ error: "ratings обязателен и должен быть непустым массивом" });
    return;
  }

  const assessment = await loadOwnedAssessment(req, res, "id");
  if (!assessment) return;

  await db.transaction(async (client) => {
    for (const r of ratings) {
      await client.query(
        `INSERT INTO self_assessment_ratings (assessment_id, competency_item_id, rating)
         VALUES ($1, $2, $3)
         ON CONFLICT (assessment_id, competency_item_id) DO UPDATE SET rating = $3`,
        [assessmentId, r.competencyItemId, r.rating]
      );
    }
  });

  res.json({ assessmentId, saved: ratings.length });
}

module.exports = {
  startAssessment,
  getAssessment,
  getQuiz,
  submitQuizResponses,
  getPracticalTask,
  submitPracticalSubmission,
  getSelfAssessmentItems,
  submitSelfAssessment,
};
