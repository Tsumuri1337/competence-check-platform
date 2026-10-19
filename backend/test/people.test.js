const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, uniqueEmail, registerPerson, cleanupPerson, cookieFrom, TEST_PASSWORD, pool } = require("../test-support/helpers");

let server, baseUrl;
const emails = [];
function newEmail(prefix) {
  const e = uniqueEmail(prefix);
  emails.push(e);
  return e;
}

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
});

test.after(async () => {
  for (const e of emails) await cleanupPerson(e);
  server.close();
  await pool.end();
});

async function post(path, body, cookie) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test("register validates phone, password, context and requires OSINT consent", async () => {
  const base = { fullName: "Иван Петров", email: newEmail("reg-invalid"), phone: "+7 900 000-00-00", password: TEST_PASSWORD, context: "candidate", osintConsent: true };
  for (const [patch, needle] of [
    [{ phone: "abc" }, "телефон"],
    [{ password: "short" }, "пароль"],
    [{ context: "boss" }, "context"],
    [{ osintConsent: false }, "согласие"],
    [{ osintUsername: "bad name!" }, "никнейм"],
  ]) {
    const res = await post("/api/people/register", { ...base, ...patch });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, new RegExp(needle));
  }
});

test("register -> me -> logout -> login cycle", async () => {
  const email = newEmail("reg-cycle");
  const { cookie } = await registerPerson(baseUrl, { email, fullName: "Анна Смирнова", context: "employee" });

  const me = await fetch(`${baseUrl}/api/people/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(me.email, email);
  assert.equal(me.fullName, "Анна Смирнова");
  assert.equal(me.phone, "+79001234567");
  assert.equal(me.context, "employee");
  assert.deepEqual(me.assessments, []);

  await post("/api/people/logout", {}, cookie);
  assert.equal((await fetch(`${baseUrl}/api/people/me`, { headers: { Cookie: cookie } })).status, 401);

  const bad = await post("/api/people/login", { email, password: "wrong-password-1" });
  assert.equal(bad.status, 401);
  const good = await post("/api/people/login", { email: email.toUpperCase(), password: TEST_PASSWORD });
  assert.equal(good.status, 200);
  const again = await fetch(`${baseUrl}/api/people/me`, { headers: { Cookie: cookieFrom(good) } });
  assert.equal(again.status, 200);
});

test("a reviewer session cookie is not accepted as a person session and vice versa", async () => {
  const email = newEmail("reg-separate");
  const { cookie } = await registerPerson(baseUrl, { email });
  const reviewerCookie = cookie.replace("person_session=", "reviewer_session=");
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: reviewerCookie } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/assessments`, { headers: { Cookie: cookie } })).status, 401);
});

test("repeated failed person logins lock the email out", async () => {
  const email = newEmail("reg-lockout");
  await registerPerson(baseUrl, { email });
  for (let i = 0; i < 5; i++) assert.equal((await post("/api/people/login", { email, password: "wrong-password-1" })).status, 401);
  const locked = await post("/api/people/login", { email, password: TEST_PASSWORD });
  assert.equal(locked.status, 429);
});

test("profile update changes the phone and validates the nickname", async () => {
  const email = newEmail("reg-profile");
  const { cookie } = await registerPerson(baseUrl, { email });
  const patch = (body) =>
    fetch(`${baseUrl}/api/people/me`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  assert.equal((await patch({ osintUsername: "no spaces allowed" })).status, 400);
  const ok = await patch({ phone: "8 (999) 111-22-33" });
  assert.equal(ok.status, 200);
  const me = await fetch(`${baseUrl}/api/people/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(me.phone, "89991112233");
});

test("candidate can add and delete a claimed certificate; manual-only vendors are marked needs_manual", async () => {
  const email = newEmail("reg-cert");
  const { cookie } = await registerPerson(baseUrl, { email });
  const res = await post("/api/people/me/certificates", { catalogId: "huawei-hcia-security", credentialId: "HW-123456" }, cookie);
  assert.equal(res.status, 201);
  const cert = await res.json();
  assert.equal(cert.vendor, "Huawei");
  assert.equal(cert.status, "needs_manual");
  assert.match(cert.statusDetail, /HW-123456/);
  assert.ok(cert.topics.includes("firewall"));

  assert.equal((await post("/api/people/me/certificates", { catalogId: "nope" }, cookie)).status, 400);
  assert.equal((await post("/api/people/me/certificates", { vendor: "X", name: "Y", url: "javascript:alert(1)" }, cookie)).status, 400);

  const del = await fetch(`${baseUrl}/api/people/me/certificates/${cert.id}`, { method: "DELETE", headers: { Cookie: cookie } });
  assert.equal(del.status, 200);
  const me = await fetch(`${baseUrl}/api/people/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(me.certificates.length, 0);
});
