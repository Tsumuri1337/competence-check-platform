const db = require("../db");

// ТЗ, п.3.6: "каждый просмотр анкеты или отчёта записывается в журнал
// доступа" — без возможности отключения пользователем. Поэтому это
// не middleware, которое можно случайно забыть подключить к роуту —
// вызывающий код обязан явно вызвать logAccess() в каждом обработчике,
// который отдаёт данные кандидата.
async function logAccess(reviewerId, assessmentId, action) {
  await db.query(
    "INSERT INTO access_log (reviewer_id, assessment_id, action) VALUES ($1, $2, $3)",
    [reviewerId, assessmentId, action]
  );
}

module.exports = { logAccess };
