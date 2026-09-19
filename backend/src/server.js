const path = require("path");
const express = require("express");
const cors = require("cors");

const { listStandards, getStandardByCode } = require("./routes/standards");
const {
  startAssessment,
  getAssessment,
  getQuiz,
  submitQuizResponses,
  getPracticalTask,
  submitPracticalSubmission,
  getSelfAssessmentItems,
  submitSelfAssessment,
} = require("./routes/assessments");
const { listAssessments, getAssessmentReport, scorePracticalSubmission, setDecision } = require("./routes/reviewers");
const { login, logout, me } = require("./routes/auth");
const { parseCookies } = require("./lib/cookies");

const PORT = process.env.PORT || 3001;

const app = express();
// Открытый CORS для локальной разработки — страницы могут открываться с
// другого origin и должны достучаться до API. Сузить при реальном деплое.
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  next();
});

// Раздаём обе страницы напрямую из корня проекта — временное решение для
// локального просмотра, пока нет отдельного фронтенд-проекта.
const PROJECT_ROOT = path.join(__dirname, "..", "..");
app.get("/test_flow.html", (req, res) => res.sendFile(path.join(PROJECT_ROOT, "test_flow.html")));
app.get("/reviewer_dashboard.html", (req, res) => res.sendFile(path.join(PROJECT_ROOT, "reviewer_dashboard.html")));

app.post("/api/auth/login", login);
app.post("/api/auth/logout", logout);
app.get("/api/auth/me", me);

app.get("/api/standards", listStandards);
app.get("/api/standards/:code", getStandardByCode);

app.post("/api/assessments", startAssessment);
app.get("/api/assessments", listAssessments);
app.get("/api/assessments/:id", getAssessment);
app.get("/api/assessments/:id/quiz", getQuiz);
app.post("/api/assessments/:id/quiz-responses", submitQuizResponses);
app.get("/api/assessments/:id/practical-task", getPracticalTask);
app.post("/api/assessments/:id/practical-submission", submitPracticalSubmission);
app.get("/api/assessments/:id/self-assessment", getSelfAssessmentItems);
app.post("/api/assessments/:id/self-assessment", submitSelfAssessment);
app.get("/api/assessments/:id/report", getAssessmentReport);
app.post("/api/assessments/:assessmentId/practical-submissions/:submissionId/score", scorePracticalSubmission);
app.post("/api/assessments/:id/decision", setDecision);

app.use((req, res) => {
  res.status(404).json({ error: "Маршрут не найден" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Некорректный JSON в теле запроса" });
    return;
  }
  res.status(500).json({ error: "Внутренняя ошибка сервера", detail: err.message });
});

// require.main===module гард — при `node src/server.js` слушаем порт как
// раньше; при require() из тестов (см. backend/test/) отдаём только app и
// сами поднимаем сервер на случайном порту.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Competence-check backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
