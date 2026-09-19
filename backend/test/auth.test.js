const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, loginReviewer, pool } = require("../test-support/helpers");

let server, baseUrl;

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
});

test.after(async () => {
  server.close();
  await pool.end();
});

test("login rejects a wrong password", async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "reviewer@example.ru", password: "not-the-password" }),
  });
  assert.equal(res.status, 401);
});

test("login rejects an unknown email", async () => {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.ru", password: "whatever" }),
  });
  assert.equal(res.status, 401);
});

test("protected routes 401 without a session", async () => {
  const res = await fetch(`${baseUrl}/api/assessments`);
  assert.equal(res.status, 401);
});

test("/api/auth/me 401s without a session", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(res.status, 401);
});

test("full login -> me -> protected route -> logout -> me cycle", async () => {
  const { cookie, reviewer } = await loginReviewer(baseUrl);
  assert.equal(reviewer.email, "reviewer@example.ru");

  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(meRes.status, 200);
  assert.equal((await meRes.json()).email, "reviewer@example.ru");

  const listRes = await fetch(`${baseUrl}/api/assessments`, { headers: { Cookie: cookie } });
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(await listRes.json()));

  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(logoutRes.status, 200);

  // Сессия должна быть недействительна на сервере, а не только на клиенте —
  // проверяем ту же (уже "вышедшую") куку ещё раз.
  const meAfterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(meAfterLogout.status, 401);
});
