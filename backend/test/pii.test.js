const test = require("node:test");
const assert = require("node:assert/strict");
const {
  startTestServer,
  uniqueEmail,
  loginReviewer,
  cleanupAssessment,
  cleanupPerson,
  pool,
} = require("../test-support/helpers");
const { encrypt, decrypt, emailBlindIndex } = require("../src/lib/pii");

let server, baseUrl, cookie;
const email = uniqueEmail("pii");
const fullName = "Шифров Тест Тестович";
const assessmentIds = [];

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
  ({ cookie } = await loginReviewer(baseUrl));
});

test.after(async () => {
  for (const id of assessmentIds) await cleanupAssessment(id);
  await cleanupPerson(email);
  await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
  server.close();
  await pool.end();
});

async function start() {
  const res = await fetch(`${baseUrl}/api/assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ standardCode: "06.030", context: "candidate", person: { fullName, email } }),
  });
  const { assessmentId } = await res.json();
  assessmentIds.push(assessmentId);
  return assessmentId;
}

test("encrypt/decrypt round-trips and uses a fresh IV each time", () => {
  const a = encrypt("Иванов Иван");
  const b = encrypt("Иванов Иван");
  assert.notEqual(a, b);
  assert.equal(decrypt(a), "Иванов Иван");
  assert.equal(decrypt(b), "Иванов Иван");
});

test("a tampered ciphertext is rejected, not silently decrypted", () => {
  const enc = encrypt("secret");
  const parts = enc.split(":");
  const ct = Buffer.from(parts[4], "base64");
  ct[0] ^= 1;
  parts[4] = ct.toString("base64");
  assert.throws(() => decrypt(parts.join(":")));
});

test("blind index ignores case and surrounding whitespace", () => {
  assert.equal(emailBlindIndex(" User@Example.RU "), emailBlindIndex("user@example.ru"));
});

test("name and email are stored encrypted in the database, not as plaintext", async () => {
  const id = await start();
  const { rows } = await pool.query(
    "SELECT p.full_name, p.email FROM assessments a JOIN people p ON p.id = a.person_id WHERE a.id = $1",
    [id]
  );
  assert.ok(rows[0].full_name.startsWith("enc:v1:"));
  assert.ok(rows[0].email.startsWith("enc:v1:"));
  assert.ok(!rows[0].full_name.includes("Шифров"));
  assert.ok(!rows[0].email.includes(email));
});

test("the same email reuses one person row despite random-IV ciphertext", async () => {
  await start();
  const { rows } = await pool.query("SELECT count(*) FROM people WHERE email_hash = $1", [emailBlindIndex(email)]);
  assert.equal(rows[0].count, "1");
});

test("reviewer report returns decrypted name and email", async () => {
  const id = assessmentIds[0];
  const res = await fetch(`${baseUrl}/api/assessments/${id}/report`, { headers: { Cookie: cookie } });
  const data = await res.json();
  assert.equal(data.assessment.full_name, fullName);
  assert.equal(data.assessment.email, email);
});

test("the unauthenticated assessment status endpoint does not leak PII", async () => {
  const res = await fetch(`${baseUrl}/api/assessments/${assessmentIds[0]}`);
  const data = await res.json();
  assert.equal("full_name" in data, false);
  assert.equal("email" in data, false);
});
