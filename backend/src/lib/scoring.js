const db = require("../db");
const { certificationById } = require("./certifications");

// Итоговая оценка проверки — одно число 0–100 и его разложение.
//
// Почему 0–100, а не 250/300: тест из 50 вопросов не различает кандидатов
// точнее нескольких баллов из ста, более мелкая шкала изображала бы точность,
// которой нет. Оценка детерминирована и объяснима: каждый балл можно
// показать, откуда он взялся. AI в ней не участвует, кроме одного случая:
// пока ревьюер не оценил практическое задание, временно используется
// AI-оценка полноты ответа, и итог помечается как предварительный.
//
// Компоненты (максимум):
//   knowledge     45 — тест с весом по сложности вопроса (сложный — до 2×)
//   pace           5 — доля ответов без «мгновенного угадывания» (< 3 с)
//   practical     35 — оценка ревьюера (или временно AI-оценка полноты)
//   certificates  15 — подтверждённые сертификаты: уровень × релевантность
//                      должности
// Самооценка в балл не входит (её даёт сам кандидат) — по ней считается
// только калибровка «насколько кандидат оценивает себя реалистично».
const WEIGHTS = { knowledge: 45, pace: 5, practical: 35, certificates: 15 };

// Сложность вопроса d ∈ [0, 1]. Априорно — по уровню квалификации трудовой
// функции, к которой относится вопрос (5 → 0, 8 → 1). По мере накопления
// ответов других кандидатов — смесь с эмпирической долей ошибок
// (байесовское сглаживание: при PRIOR_STRENGTH ответах вес данных и
// априорной оценки равен).
const MIN_LEVEL = 5;
const MAX_LEVEL = 8;
const PRIOR_STRENGTH = 20;
const DEFAULT_LEVEL = 6;

const RAPID_GUESS_MS = 3000;
const RAPID_GUESS_FLAG_SHARE = 0.1;

const CERT_LEVEL_POINTS = { entry: 3, associate: 5, professional: 8, specialty: 8, expert: 12 };
const CUSTOM_CERT_POINTS = 3;
const CUSTOM_CERT_RELEVANCE = 0.5;

const GRADES = [
  { min: 80, key: "expert", title: "Эксперт" },
  { min: 65, key: "strong", title: "Сильный специалист" },
  { min: 50, key: "solid", title: "Уверенный базовый уровень" },
  { min: 35, key: "junior", title: "Начальный уровень" },
  { min: 0, key: "insufficient", title: "Недостаточно для должности" },
];

function round1(x) {
  return Math.round(x * 10) / 10;
}

function difficultyOf(level, othersTotal, othersCorrect) {
  const prior = (Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level || DEFAULT_LEVEL)) - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL);
  const errors = othersTotal - othersCorrect;
  return (prior * PRIOR_STRENGTH + errors) / (PRIOR_STRENGTH + othersTotal);
}

// Подписи для отчёта (на вес не влияют — он непрерывный): уровень 5 —
// лёгкие, 6–7 — средние (их большинство), 8 — сложные.
function band(d) {
  if (d < 0.25) return "easy";
  if (d < 0.75) return "medium";
  return "hard";
}

async function knowledgeAndPace(assessment) {
  const assignment = assessment.quiz_assignment || [];
  if (!assessment.quiz_submitted_at && !assignment.length) return { knowledge: null, pace: null, questions: [] };
  const questionIds = assignment.map((a) => a.questionId);
  const { rows } = await db.query(
    `SELECT q.id, gf.qualification_level AS level, qr.is_correct, qr.time_ms,
       (SELECT count(*) FROM quiz_responses o WHERE o.question_id = q.id AND o.assessment_id <> $2)::int AS others_total,
       (SELECT count(*) FROM quiz_responses o WHERE o.question_id = q.id AND o.assessment_id <> $2 AND o.is_correct)::int AS others_correct
     FROM quiz_questions q
     LEFT JOIN labor_functions lf ON lf.id = q.labor_function_id
     LEFT JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     LEFT JOIN quiz_responses qr ON qr.question_id = q.id AND qr.assessment_id = $2
     WHERE q.id = ANY($1)`,
    [questionIds, assessment.id]
  );
  const questions = rows.map((r) => {
    const difficulty = difficultyOf(r.level, r.others_total, r.others_correct);
    return { id: r.id, difficulty, band: band(difficulty), answered: r.is_correct !== null, correct: r.is_correct === true, timeMs: r.time_ms };
  });

  if (!assessment.quiz_submitted_at) return { knowledge: null, pace: null, questions };

  // Неотвеченный вопрос из выборки считается неверным: иначе выгодно
  // пропускать сложные вопросы.
  let weighted = 0;
  let weightTotal = 0;
  const bands = { easy: { correct: 0, total: 0 }, medium: { correct: 0, total: 0 }, hard: { correct: 0, total: 0 } };
  for (const q of questions) {
    const w = 1 + q.difficulty;
    weightTotal += w;
    if (q.correct) weighted += w;
    bands[q.band].total += 1;
    if (q.correct) bands[q.band].correct += 1;
  }
  const correct = questions.filter((q) => q.correct).length;
  const ratio = weightTotal ? weighted / weightTotal : 0;
  const knowledge = {
    key: "knowledge",
    title: "Знания (тест с учётом сложности)",
    max: WEIGHTS.knowledge,
    points: round1(WEIGHTS.knowledge * ratio),
    details: {
      correct,
      total: questions.length,
      rawPercent: questions.length ? Math.round((correct / questions.length) * 100) : 0,
      weightedPercent: Math.round(ratio * 100),
      byDifficulty: bands,
    },
  };

  const timed = questions.filter((q) => q.answered && Number.isFinite(q.timeMs));
  let pace = null;
  if (timed.length) {
    const rapid = timed.filter((q) => q.timeMs < RAPID_GUESS_MS);
    const sorted = timed.map((q) => q.timeMs).sort((a, b) => a - b);
    const engagement = 1 - rapid.length / timed.length;
    pace = {
      key: "pace",
      title: "Темп и вдумчивость ответов",
      max: WEIGHTS.pace,
      points: round1(WEIGHTS.pace * engagement),
      details: {
        timedAnswers: timed.length,
        rapidGuesses: rapid.length,
        rapidGuessesCorrect: rapid.filter((q) => q.correct).length,
        medianSeconds: Math.round(sorted[Math.floor(sorted.length / 2)] / 1000),
        totalMinutes: Math.round(sorted.reduce((s, t) => s + t, 0) / 60000),
      },
    };
  }
  return { knowledge, pace, questions };
}

async function practical(assessment, aiFullness) {
  const assigned = assessment.task_assignment || [];
  if (!assigned.length) return null;
  const { rows } = await db.query(
    "SELECT task_id, reviewer_score FROM practical_submissions WHERE assessment_id = $1 AND task_id = ANY($2)",
    [assessment.id, assigned]
  );
  const byTask = new Map(rows.map((r) => [r.task_id, r]));
  const tasks = assigned.map((taskId) => {
    const s = byTask.get(taskId);
    if (!s) return { taskId, source: "not_submitted", score: 0 };
    if (s.reviewer_score !== null) return { taskId, source: "reviewer", score: s.reviewer_score };
    if (aiFullness.has(taskId)) return { taskId, source: "ai", score: aiFullness.get(taskId) };
    return { taskId, source: "pending", score: null };
  });
  const scored = tasks.filter((t) => t.score !== null);
  if (!scored.length) return { pending: true, tasks };
  // Не отправленное задание = 0; ещё не оценённое — не учитывается (итог предварительный).
  const avg = scored.reduce((s, t) => s + t.score, 0) / scored.length;
  return {
    key: "practical",
    title: "Практические задания",
    max: WEIGHTS.practical,
    points: round1((WEIGHTS.practical * avg) / 100),
    details: { averageScore: Math.round(avg), tasks },
    pending: tasks.some((t) => t.source === "pending" || t.source === "ai"),
  };
}

async function standardTopicSlugs(standardId) {
  const { rows } = await db.query(
    `SELECT DISTINCT t.slug FROM competency_item_topics cit
     JOIN topics t ON t.id = cit.topic_id
     JOIN competency_items ci ON ci.id = cit.competency_item_id
     JOIN labor_functions lf ON lf.id = ci.labor_function_id
     JOIN generalized_functions gf ON gf.id = lf.generalized_function_id
     WHERE gf.standard_id = $1`,
    [standardId]
  );
  return new Set(rows.map((r) => r.slug));
}

async function certificates(assessment) {
  const { rows } = await db.query(
    "SELECT id, catalog_id, vendor, name FROM certificates WHERE person_id = $1 AND status = 'verified'",
    [assessment.person_id]
  );
  const relevant = await standardTopicSlugs(assessment.standard_id);
  const items = rows
    .map((c) => {
      const catalog = c.catalog_id ? certificationById.get(c.catalog_id) : null;
      const levelPoints = catalog ? CERT_LEVEL_POINTS[catalog.level] || CUSTOM_CERT_POINTS : CUSTOM_CERT_POINTS;
      const relevance = catalog ? catalog.topics.filter((t) => relevant.has(t)).length / catalog.topics.length : CUSTOM_CERT_RELEVANCE;
      // Даже нерелевантный должности сертификат показывает дисциплину
      // обучения — четверть стоимости; полностью релевантный — вся.
      const value = levelPoints * (0.25 + 0.75 * relevance);
      return { id: c.id, name: `${c.vendor} ${c.name}`, level: catalog ? catalog.level : "custom", relevancePercent: Math.round(relevance * 100), value: round1(value) };
    })
    .sort((a, b) => b.value - a.value);
  const sum = items.reduce((s, c) => s + c.value, 0);
  return {
    key: "certificates",
    title: "Подтверждённые сертификаты",
    max: WEIGHTS.certificates,
    points: round1(Math.min(WEIGHTS.certificates, sum)),
    details: { certificates: items, uncappedPoints: round1(sum) },
  };
}

// Калибровка самооценки: средняя самооценка по пунктам (1–5 → 0–100%)
// против доли верных ответов теста — на балл не влияет.
async function selfCalibration(assessment, knowledge) {
  if (!knowledge) return null;
  const { rows } = await db.query("SELECT avg(rating)::float AS avg, count(*)::int AS n FROM self_assessment_ratings WHERE assessment_id = $1", [assessment.id]);
  if (!rows[0].n) return null;
  const selfPercent = Math.round(((rows[0].avg - 1) / 4) * 100);
  const gap = selfPercent - knowledge.details.rawPercent;
  return {
    selfPercent,
    testPercent: knowledge.details.rawPercent,
    gap,
    verdict: gap > 20 ? "overestimates" : gap < -20 ? "underestimates" : "realistic",
  };
}

async function latestAiFullness(assessmentId) {
  const { rows } = await db.query(
    "SELECT content FROM ai_summaries WHERE assessment_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    [assessmentId]
  );
  const map = new Map();
  for (const p of (rows[0] && rows[0].content.practicalAssessments) || []) map.set(p.taskId, p.fullness);
  return map;
}

async function computeScore(assessmentId) {
  const { rows } = await db.query(
    "SELECT id, person_id, standard_id, status, quiz_assignment, task_assignment, quiz_submitted_at FROM assessments WHERE id = $1",
    [assessmentId]
  );
  const assessment = rows[0];
  if (!assessment) return null;

  const aiFullness = await latestAiFullness(assessmentId);
  const [{ knowledge, pace }, practicalPart, certs] = await Promise.all([
    knowledgeAndPace(assessment),
    practical(assessment, aiFullness),
    certificates(assessment),
  ]);

  const flags = [];
  const reasons = [];
  if (!knowledge) reasons.push("тест ещё не отправлен");
  if (!practicalPart || practicalPart.pending) {
    reasons.push(
      practicalPart && (practicalPart.tasks || practicalPart.details.tasks).some((t) => t.source === "ai")
        ? "практическое задание оценено AI, не ревьюером"
        : "практическое задание ещё не оценено ревьюером"
    );
  }
  if (pace && pace.details.rapidGuesses / pace.details.timedAnswers > RAPID_GUESS_FLAG_SHARE) {
    flags.push(
      `${pace.details.rapidGuesses} ответ(ов) дано быстрее ${RAPID_GUESS_MS / 1000} с — возможное угадывание (из них верных: ${pace.details.rapidGuessesCorrect})`
    );
  }

  // Компоненты без данных (нет замеров времени у старых проверок, задание
  // не оценено) не обнуляют итог, а исключаются: балл пересчитывается на
  // оставшийся максимум — и помечается как предварительный.
  const components = [knowledge, pace, practicalPart && practicalPart.points !== undefined ? practicalPart : null, certs].filter(Boolean);
  const earned = components.reduce((s, c) => s + c.points, 0);
  const possible = components.reduce((s, c) => s + c.max, 0);
  const total = knowledge ? Math.round((earned / possible) * 100) : null;
  const grade = total === null ? null : GRADES.find((g) => total >= g.min);

  return {
    total,
    scale: 100,
    grade: grade ? { key: grade.key, title: grade.title } : null,
    provisional: reasons.length > 0,
    provisionalReasons: reasons,
    components,
    missing: Object.keys(WEIGHTS).filter((k) => !components.some((c) => c.key === k)),
    flags,
    selfCalibration: await selfCalibration(assessment, knowledge),
    method: {
      weights: WEIGHTS,
      grades: GRADES.map((g) => ({ min: g.min, title: g.title })),
      difficulty: `по уровню квалификации ТФ (${MIN_LEVEL}–${MAX_LEVEL}), уточняется по доле ошибок других кандидатов (сглаживание ${PRIOR_STRENGTH} ответов)`,
      rapidGuessSeconds: RAPID_GUESS_MS / 1000,
    },
  };
}

module.exports = { computeScore, difficultyOf, WEIGHTS, GRADES };
