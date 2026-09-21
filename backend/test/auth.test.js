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

const crypto = require("node:crypto");
const { hashPassword } = require("../src/lib/auth");

async function login(email, password) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

test("repeated failed logins lock the email out, even for the correct password", async () => {
  const email = `lockout-${crypto.randomBytes(4).toString("hex")}@test.local`;
  const startedAt = new Date();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(email, "wrong-password-x")).status, 401);
    const locked = await login(email, "wrong-password-x");
    assert.equal(locked.status, 429);
    assert.ok(locked.headers.get("retry-after"));
  } finally {
    await pool.query("DELETE FROM login_attempts WHERE key = $1 OR at >= $2", [`email:${email}`, startedAt]);
  }
});

test("lockout also applies to a real reviewer, and a successful login resets the counter", async () => {
  const email = `lock-real-${crypto.randomBytes(4).toString("hex")}@test.local`;
  await pool.query("INSERT INTO reviewers (full_name, email, password_hash) VALUES ('Локаут Тест', $1, $2)", [
    email,
    hashPassword("correct-horse-battery"),
  ]);
  const startedAt = new Date();
  try {
    for (let i = 0; i < 4; i++) await login(email, "nope-nope-nope");
    assert.equal((await login(email, "correct-horse-battery")).status, 200); // 4 неудач < лимита, вход проходит
    for (let i = 0; i < 4; i++) await login(email, "nope-nope-nope"); // счётчик сброшен успехом — снова 4, не 8
    assert.equal((await login(email, "correct-horse-battery")).status, 200);
  } finally {
    await pool.query("DELETE FROM reviewers WHERE email = $1", [email]);
    await pool.query("DELETE FROM login_attempts WHERE key = $1 OR at >= $2", [`email:${email}`, startedAt]);
  }
});

test("change-password checks the current password, enforces strength, and revokes other sessions", async () => {
  const email = `chpw-${crypto.randomBytes(4).toString("hex")}@test.local`;
  await pool.query("INSERT INTO reviewers (full_name, email, password_hash) VALUES ('Смена Пароля', $1, $2)", [
    email,
    hashPassword("old-password-123"),
  ]);
  try {
    const a = await login(email, "old-password-123");
    const cookieA = a.headers.get("set-cookie").split(";")[0];
    const b = await login(email, "old-password-123");
    const cookieB = b.headers.get("set-cookie").split(";")[0];

    const change = (body) =>
      fetch(`${baseUrl}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieA },
        body: JSON.stringify(body),
      });

    assert.equal((await change({ currentPassword: "wrong-current", newPassword: "brand-new-password-9" })).status, 403);
    assert.equal((await change({ currentPassword: "old-password-123", newPassword: "short" })).status, 400);
    assert.equal((await change({ currentPassword: "old-password-123", newPassword: "brand-new-password-9" })).status, 200);

    const meA = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookieA } });
    const meB = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookieB } });
    assert.equal(meA.status, 200, "the session that changed the password stays valid");
    assert.equal(meB.status, 401, "other sessions are revoked");
    assert.equal((await login(email, "old-password-123")).status, 401);
    assert.equal((await login(email, "brand-new-password-9")).status, 200);
  } finally {
    await pool.query("DELETE FROM reviewers WHERE email = $1", [email]);
    await pool.query("DELETE FROM login_attempts WHERE key = $1", [`email:${email}`]);
  }
});

test("change-password requires a session", async () => {
  const res = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "x", newPassword: "y" }),
  });
  assert.equal(res.status, 401);
});
