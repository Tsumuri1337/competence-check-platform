// Общие утилиты для тестов. Каждый тестовый файл поднимает приложение на
// случайном порту (app.listen(0)) и работает через обычный fetch — без
// supertest/nock, без новых зависимостей. Тесты создают только свои
// собственные строки (с уникальным email) и подчищают их за собой в
// after() — поэтому набор безопасно гонять как на CI-инстансе Postgres
// (свежая БД), так и на локальной dev-БД разработчика (общие данные
// профстандартов не трогаются).
//
// OSINT в тестах не ходит в интернет: Sherlock подменён скриптом
// fake-sherlock.js, Credly — локальным фейковым сервером (fake-credly.js).
const path = require("path");
process.env.SHERLOCK_BIN = path.join(__dirname, "fake-sherlock.js");

const app = require("../src/server");
const { pool } = require("../src/db");
const { emailBlindIndex } = require("../src/lib/pii");
const { waitForOsintIdle } = require("../src/lib/osint");
const { startFakeCredly } = require("./fake-credly");

let fakeCredly = null;

async function startTestServer() {
  fakeCredly = await startFakeCredly();
  process.env.CREDLY_BASE_URL = fakeCredly.url;
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const close = server.close.bind(server);
  server.close = (cb) => {
    fakeCredly.server.close();
    return close(cb);
  };
  return { server, baseUrl: `http://localhost:${port}`, fakeCredly };
}

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

function cookieFrom(res) {
  return res.headers.get("set-cookie").split(";")[0];
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
  return { cookie: cookieFrom(res), reviewer: await res.json() };
}

const TEST_PASSWORD = "test-password-123";

// Регистрирует кандидата/сотрудника и возвращает { cookie, id }.
async function registerPerson(baseUrl, { email, fullName = "Тестовый Кандидат", context = "candidate", osintUsername, phone = "+7 900 123-45-67" }) {
  const res = await fetch(`${baseUrl}/api/people/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName, email, phone, password: TEST_PASSWORD, context, osintUsername, osintConsent: true }),
  });
  if (res.status !== 201) throw new Error(`Регистрация не удалась: ${res.status} ${await res.text()}`);
  return { cookie: cookieFrom(res), id: (await res.json()).id };
}

// Начинает проверку от имени вошедшего человека.
async function startAssessment(baseUrl, cookie, standardCode = "06.030") {
  const res = await fetch(`${baseUrl}/api/assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ standardCode }),
  });
  if (res.status !== 201) throw new Error(`Старт проверки не удался: ${res.status} ${await res.text()}`);
  return (await res.json()).assessmentId;
}

// Полная очистка проверки: assessment + всё, что на него ссылается и не
// удаляется каскадом (access_log — единственная такая таблица, см. schema.sql).
async function cleanupAssessment(assessmentId) {
  await pool.query("DELETE FROM access_log WHERE assessment_id = $1", [assessmentId]);
  await pool.query("DELETE FROM assessments WHERE id = $1", [assessmentId]);
}

// Сессии, сертификаты и OSINT-запуски удаляются каскадом; фоновый OSINT
// сначала дожидаемся, чтобы он не писал в уже удалённого человека.
async function cleanupPerson(email) {
  await waitForOsintIdle();
  const { rows } = await pool.query("SELECT id FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
  for (const { id } of rows) {
    const assessments = await pool.query("SELECT id FROM assessments WHERE person_id = $1", [id]);
    for (const a of assessments.rows) await cleanupAssessment(a.id);
  }
  await pool.query("DELETE FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
  await pool.query("DELETE FROM login_attempts WHERE key = $1", [`person-email:${email.toLowerCase()}`]);
}

module.exports = {
  startTestServer,
  uniqueEmail,
  loginReviewer,
  registerPerson,
  startAssessment,
  cleanupAssessment,
  cleanupPerson,
  waitForOsintIdle,
  cookieFrom,
  TEST_PASSWORD,
  pool,
};
