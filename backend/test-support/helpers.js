// Общие утилиты для тестов. Каждый тестовый файл поднимает приложение на
// случайном порту (app.listen(0)) и работает через обычный fetch — без
// supertest/nock, без новых зависимостей. Тесты создают только свои
// собственные строки (с уникальным email) и подчищают их за собой в
// after() — поэтому набор безопасно гонять как на CI-инстансе Postgres
// (свежая БД), так и на локальной dev-БД разработчика (общие данные
// профстандартов не трогаются).
const app = require("../src/server");
const { pool } = require("../src/db");
const { emailBlindIndex } = require("../src/lib/pii");

async function startTestServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://localhost:${port}` };
}

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

// Логинится демо-ревьюером (см. backend/src/seed.js) и возвращает заголовок
// Cookie для последующих запросов — глобального cookie jar в fetch нет,
// поэтому куку передаём вручную.
async function loginReviewer(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "reviewer@example.ru", password: "reviewer123" }),
  });
  if (!res.ok) throw new Error("Не удалось войти демо-ревьюером — проверьте, что seed.js применён");
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie.split(";")[0];
  return { cookie, reviewer: await res.json() };
}

// Полная очистка проверки: assessment + всё, что на него ссылается и не
// удаляется каскадом (access_log — единственная такая таблица, см. schema.sql).
async function cleanupAssessment(assessmentId) {
  await pool.query("DELETE FROM access_log WHERE assessment_id = $1", [assessmentId]);
  await pool.query("DELETE FROM assessments WHERE id = $1", [assessmentId]);
}

async function cleanupPerson(email) {
  await pool.query("DELETE FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
}

module.exports = { startTestServer, uniqueEmail, loginReviewer, cleanupAssessment, cleanupPerson, pool };
