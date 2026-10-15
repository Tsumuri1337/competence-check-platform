const test = require("node:test");
const assert = require("node:assert/strict");
const {
  startTestServer,
  uniqueEmail,
  loginReviewer,
  registerParticipant,
  fetchAs,
  PARTICIPANT_PASSWORD,
  cleanupAssessment,
  cleanupPerson,
  pool,
} = require("../test-support/helpers");

let server, baseUrl;
const emails = [];
const assessmentIds = [];

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
});

test.after(async () => {
  for (const id of assessmentIds) await cleanupAssessment(id);
  for (const email of emails) await cleanupPerson(email);
  await pool.query("DELETE FROM login_attempts WHERE key = ANY($1)", [emails.map((e) => `participant-email:${e}`)]);
  server.close();
  await pool.end();
});

function newEmail(prefix) {
  const email = uniqueEmail(prefix);
  emails.push(email);
  return email;
}

function post(path, body, cookie) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

async function startAssessment(api) {
  const res = await api(`${baseUrl}/api/assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ standardCode: "06.033" }),
  });
  assert.equal(res.status, 201);
  const { assessmentId } = await res.json();
  assessmentIds.push(assessmentId);
  return assessmentId;
}

test("register creates an account, logs it in and returns the profile", async () => {
  const email = newEmail("reg");
  const { cookie, participant } = await registerParticipant(baseUrl, {
    email,
    context: "employee",
    fullName: "Сотрудник Тестов",
    organizationName: "ООО Тест",
  });
  assert.equal(participant.email, email);
  assert.equal(participant.fullName, "Сотрудник Тестов");
  assert.equal(participant.context, "employee");
  assert.equal(participant.organizationName, "ООО Тест");

  const me = await fetch(`${baseUrl}/api/participant/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).email, email);
});

test("register rejects a duplicate email, a weak password and an unknown context", async () => {
  const email = newEmail("dup");
  await registerParticipant(baseUrl, { email });
  const dup = await post("/api/participant/register", { email: email.toUpperCase(), fullName: "X", context: "candidate", password: PARTICIPANT_PASSWORD });
  assert.equal(dup.status, 409);

  const weak = await post("/api/participant/register", { email: newEmail("weak"), fullName: "X", context: "candidate", password: "short" });
  assert.equal(weak.status, 400);

  const badContext = await post("/api/participant/register", { email: newEmail("ctx"), fullName: "X", context: "admin", password: PARTICIPANT_PASSWORD });
  assert.equal(badContext.status, 400);
});

test("login checks the password and the session survives until logout", async () => {
  const email = newEmail("login");
  await registerParticipant(baseUrl, { email });

  assert.equal((await post("/api/participant/login", { email, password: "wrong-password-x" })).status, 401);
  assert.equal((await post("/api/participant/login", { email: "nobody-here@test.local", password: PARTICIPANT_PASSWORD })).status, 401);

  const ok = await post("/api/participant/login", { email, password: PARTICIPANT_PASSWORD });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  assert.ok(cookie.startsWith("participant_session="));

  assert.equal((await post("/api/participant/logout", {}, cookie)).status, 200);
  const me = await fetch(`${baseUrl}/api/participant/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 401);
});

test("repeated failed participant logins lock the email out", async () => {
  const email = newEmail("lock");
  await registerParticipant(baseUrl, { email });
  for (let i = 0; i < 5; i++) assert.equal((await post("/api/participant/login", { email, password: "wrong-password-x" })).status, 401);
  const locked = await post("/api/participant/login", { email, password: PARTICIPANT_PASSWORD });
  assert.equal(locked.status, 429);
});

test("assessment endpoints require a participant session", async () => {
  const start = await post("/api/assessments", { standardCode: "06.033" });
  assert.equal(start.status, 401);

  const api = fetchAs((await registerParticipant(baseUrl, { email: newEmail("anon") })).cookie);
  const id = await startAssessment(api);
  for (const path of ["", "/quiz", "/practical-task", "/self-assessment"]) {
    const res = await fetch(`${baseUrl}/api/assessments/${id}${path}`);
    assert.equal(res.status, 401, `GET ${path || "/"} without a session`);
  }
});

test("a participant cannot read or answer someone else's assessment", async () => {
  const owner = fetchAs((await registerParticipant(baseUrl, { email: newEmail("owner") })).cookie);
  const intruderCookie = (await registerParticipant(baseUrl, { email: newEmail("intruder") })).cookie;
  const intruder = fetchAs(intruderCookie);
  const id = await startAssessment(owner);

  for (const path of ["", "/quiz", "/practical-task", "/self-assessment"]) {
    const res = await intruder(`${baseUrl}/api/assessments/${id}${path}`);
    assert.equal(res.status, 404, `GET ${path || "/"} as another participant`);
  }
  const answer = await post(`/api/assessments/${id}/quiz-responses`, { responses: [{ questionId: 1, selectedIndex: 0 }] }, intruderCookie);
  assert.equal(answer.status, 404);
  const submit = await post(`/api/assessments/${id}/practical-submission`, { taskId: 1, submissionText: "чужое" }, intruderCookie);
  assert.equal(submit.status, 404);

  // Ревьюерская кука не заменяет участника: это разные сессии.
  const { cookie: reviewerCookie } = await loginReviewer(baseUrl);
  const asReviewer = await fetch(`${baseUrl}/api/assessments/${id}/quiz`, { headers: { Cookie: reviewerCookie } });
  assert.equal(asReviewer.status, 401);
  await post("/api/auth/logout", {}, reviewerCookie);
});

test("assessment takes context from the account and the participant sees only their own list", async () => {
  const email = newEmail("mine");
  const api = fetchAs((await registerParticipant(baseUrl, { email, context: "employee" })).cookie);
  const other = fetchAs((await registerParticipant(baseUrl, { email: newEmail("theirs") })).cookie);
  const mine = await startAssessment(api);
  await startAssessment(other);

  const status = await api(`${baseUrl}/api/assessments/${mine}`).then((r) => r.json());
  assert.equal(status.context, "employee");

  const list = await api(`${baseUrl}/api/participant/assessments`).then((r) => r.json());
  assert.deepEqual(
    list.map((a) => a.id),
    [mine]
  );
  assert.equal(list[0].standard_code, "06.033");
});

test("changing the password revokes the participant's other sessions", async () => {
  const email = newEmail("pw");
  const { cookie: first } = await registerParticipant(baseUrl, { email });
  const login = await post("/api/participant/login", { email, password: PARTICIPANT_PASSWORD });
  const second = login.headers.get("set-cookie").split(";")[0];

  const res = await post("/api/participant/change-password", { currentPassword: PARTICIPANT_PASSWORD, newPassword: "another-pass-456" }, second);
  assert.equal(res.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/participant/me`, { headers: { Cookie: first } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/participant/me`, { headers: { Cookie: second } })).status, 200);
  assert.equal((await post("/api/participant/login", { email, password: "another-pass-456" })).status, 200);
});
