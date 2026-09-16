const db = require("../db");

// POST /api/assessments
// body: { standardCode, context: 'employee'|'candidate', person: { fullName, email, organizationName? } }
async function startAssessment(req, res) {
  const { standardCode, context, person } = req.body || {};

  if (!standardCode || !context || !person || !person.fullName || !person.email) {
    res.status(400).json({ error: "standardCode, context и person.{fullName,email} обязательны" });
    return;
  }
  if (!["employee", "candidate"].includes(context)) {
    res.status(400).json({ error: "context должен быть employee | candidate" });
    return;
  }

  const standardResult = await db.query("SELECT id FROM standards WHERE code = $1", [standardCode]);
  const standard = standardResult.rows[0];
  if (!standard) {
    res.status(404).json({ error: "Профстандарт не найден" });
    return;
  }

  const assessmentId = await db.transaction(async (client) => {
    let organizationId = null;
    if (person.organizationName) {
      const orgResult = await client.query("SELECT id FROM organizations WHERE name = $1", [person.organizationName]);
      organizationId = orgResult.rows[0]
        ? orgResult.rows[0].id
        : (await client.query("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [person.organizationName])).rows[0].id;
    }

    const existingPerson = await client.query("SELECT id FROM people WHERE email = $1", [person.email]);
    const personId = existingPerson.rows[0]
      ? existingPerson.rows[0].id
      : (
          await client.query(
            "INSERT INTO people (full_name, email, context, organization_id) VALUES ($1, $2, $3, $4) RETURNING id",
            [person.fullName, person.email, context, organizationId]
          )
        ).rows[0].id;

    const appResult = await client.query(
      "INSERT INTO assessments (person_id, standard_id, context) VALUES ($1, $2, $3) RETURNING id",
      [personId, standard.id, context]
    );
    return appResult.rows[0].id;
  });

  res.status(201).json({ assessmentId, status: "in_progress" });
}

// GET /api/assessments/:id
async function getAssessment(req, res) {
  const assessmentId = Number(req.params.id);
  const { rows } = await db.query(
    `SELECT a.id, a.status, a.context, a.created_at, p.full_name, p.email, s.code as standard_code, s.title as standard_title
     FROM assessments a
     JOIN people p ON p.id = a.person_id
     JOIN standards s ON s.id = a.standard_id
     WHERE a.id = $1`,
    [assessmentId]
  );
  const assessment = rows[0];
  if (!assessment) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }
  res.json(assessment);
}

// GET /api/assessments/:id/quiz — вопросы без правильных ответов
async function getQuiz(req, res) {
  const assessmentId = Number(req.params.id);
  const assessmentResult = await db.query("SELECT standard_id FROM assessments WHERE id = $1", [assessmentId]);
  const assessment = assessmentResult.rows[0];
  if (!assessment) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }
  const { rows } = await db.query(
    "SELECT id, text, options FROM quiz_questions WHERE standard_id = $1 ORDER BY id",
    [assessment.standard_id]
  );
  res.json(rows);
}

// POST /api/assessments/:id/quiz-responses
// body: { responses: [{ questionId, selectedIndex }] }
async function submitQuizResponses(req, res) {
  const assessmentId = Number(req.params.id);
  const { responses } = req.body || {};
  if (!Array.isArray(responses) || responses.length === 0) {
    res.status(400).json({ error: "responses обязателен и должен быть непустым массивом" });
    return;
  }

  const assessmentResult = await db.query("SELECT id FROM assessments WHERE id = $1", [assessmentId]);
  if (!assessmentResult.rows[0]) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }

  const score = await db.transaction(async (client) => {
    let correctCount = 0;
    for (const r of responses) {
      const qResult = await client.query("SELECT correct_index FROM quiz_questions WHERE id = $1", [r.questionId]);
      const question = qResult.rows[0];
      if (!question) continue;
      const isCorrect = question.correct_index === r.selectedIndex;
      if (isCorrect) correctCount += 1;
      await client.query(
        `INSERT INTO quiz_responses (assessment_id, question_id, selected_index, is_correct)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (assessment_id, question_id) DO UPDATE SET selected_index = $3, is_correct = $4`,
        [assessmentId, r.questionId, r.selectedIndex, isCorrect]
      );
    }
    return { correctCount, total: responses.length };
  });

  res.json({ assessmentId, ...score });
}

// GET /api/assessments/:id/practical-task
async function getPracticalTask(req, res) {
  const assessmentId = Number(req.params.id);
  const assessmentResult = await db.query("SELECT standard_id FROM assessments WHERE id = $1", [assessmentId]);
  const assessment = assessmentResult.rows[0];
  if (!assessment) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }
  const { rows } = await db.query(
    "SELECT id, prompt FROM practical_tasks WHERE standard_id = $1 ORDER BY id",
    [assessment.standard_id]
  );
  res.json(rows);
}

// POST /api/assessments/:id/practical-submission
// body: { taskId, submissionText } — completes the assessment once every
// practical task for the standard has a submission (quiz is required first;
// self-assessment is optional and doesn't gate completion).
async function submitPracticalSubmission(req, res) {
  const assessmentId = Number(req.params.id);
  const { taskId, submissionText } = req.body || {};
  if (!taskId || !submissionText) {
    res.status(400).json({ error: "taskId и submissionText обязательны" });
    return;
  }

  const assessmentResult = await db.query("SELECT standard_id FROM assessments WHERE id = $1", [assessmentId]);
  const assessment = assessmentResult.rows[0];
  if (!assessment) {
    res.status(404).json({ error: "Проверка не найдена" });
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

    const totalTasks = await client.query("SELECT count(*) FROM practical_tasks WHERE standard_id = $1", [assessment.standard_id]);
    const totalSubmissions = await client.query("SELECT count(*) FROM practical_submissions WHERE assessment_id = $1", [assessmentId]);
    if (Number(totalSubmissions.rows[0].count) >= Number(totalTasks.rows[0].count)) {
      await client.query("UPDATE assessments SET status = 'completed' WHERE id = $1", [assessmentId]);
    }

    return inserted.rows[0].id;
  });

  res.status(201).json({ submissionId });
}

// GET /api/assessments/:id/self-assessment — пункты для оценки, сгруппированные по ТФ
async function getSelfAssessmentItems(req, res) {
  const assessmentId = Number(req.params.id);
  const assessmentResult = await db.query("SELECT standard_id FROM assessments WHERE id = $1", [assessmentId]);
  const assessment = assessmentResult.rows[0];
  if (!assessment) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }
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

  const assessmentResult = await db.query("SELECT id FROM assessments WHERE id = $1", [assessmentId]);
  if (!assessmentResult.rows[0]) {
    res.status(404).json({ error: "Проверка не найдена" });
    return;
  }

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
