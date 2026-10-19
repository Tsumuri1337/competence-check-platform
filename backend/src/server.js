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
const {
  listAssessments,
  getAssessmentReport,
  scorePracticalSubmission,
  setDecision,
  rerunOsintForAssessment,
  reviewCertificate,
  createAiSummary,
  getAiSummaryPrompt,
  importAiSummary,
} = require("./routes/reviewers");
const { login, logout, me, changePassword } = require("./routes/auth");
const people = require("./routes/people");
const requirements = require("./routes/requirements");
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
const PAGES = ["index.html", "test_flow.html", "reviewer_dashboard.html", "requirements.html"];
for (const page of PAGES) app.get(`/${page}`, (req, res) => res.sendFile(path.join(PROJECT_ROOT, page)));
app.get("/", (req, res) => res.sendFile(path.join(PROJECT_ROOT, "index.html")));

app.post("/api/auth/login", login);
app.post("/api/auth/logout", logout);
app.get("/api/auth/me", me);
app.post("/api/auth/change-password", changePassword);

// Личный кабинет кандидата/сотрудника.
app.post("/api/people/register", people.register);
app.post("/api/people/login", people.login);
app.post("/api/people/logout", people.logout);
app.get("/api/people/me", people.me);
app.patch("/api/people/me", people.updateProfile);
app.post("/api/people/me/certificates", people.addCertificate);
app.delete("/api/people/me/certificates/:certId", people.deleteCertificate);
app.post("/api/people/me/osint", people.rerunOsint);

app.get("/api/standards", listStandards);
app.get("/api/standards/:code", getStandardByCode);
app.get("/api/standards/:code/topics", requirements.getStandardTopicIndex);

// Справочник требований (вкладка «Требования»).
app.get("/api/topics", requirements.listTopics);
app.get("/api/topics/:slug", requirements.getTopic);
app.get("/api/labor-functions/:id", requirements.getLaborFunction);
app.get("/api/competency-items/:id", requirements.getCompetencyItem);
app.get("/api/requirements/search", requirements.search);
app.get("/api/certifications", requirements.listCertifications);

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
app.post("/api/assessments/:id/osint", rerunOsintForAssessment);
app.post("/api/assessments/:id/certificates/:certId/review", reviewCertificate);
app.post("/api/assessments/:id/ai-summary", createAiSummary);
app.get("/api/assessments/:id/ai-summary/prompt", getAiSummaryPrompt);
app.post("/api/assessments/:id/ai-summary/import", importAiSummary);

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
