const test = require("node:test");
const assert = require("node:assert/strict");
const {
  startTestServer,
  uniqueEmail,
  registerPerson,
  startAssessment,
  loginReviewer,
  cleanupPerson,
  waitForOsintIdle,
  pool,
} = require("../test-support/helpers");
const { parseSherlockOutput } = require("../src/lib/osint/sherlock");
const { namesMatch, nameSlugs } = require("../src/lib/osint/names");
const { matchCatalog } = require("../src/lib/certifications");
const { parseBadgeUrl } = require("../src/lib/osint/credly");

let server, baseUrl, fakeCredly;
const emails = [];

test.before(async () => {
  ({ server, baseUrl, fakeCredly } = await startTestServer());
});

test.after(async () => {
  for (const e of emails) await cleanupPerson(e);
  server.close();
  await pool.end();
});

async function me(cookie) {
  return fetch(`${baseUrl}/api/people/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
}

test("Sherlock output parser attributes found profiles to the right username", () => {
  const out = "[*] Checking username alice on:\n\n[+] GitHub: https://www.github.com/alice\n[*] Checking username bob on:\n[+] TryHackMe: https://tryhackme.com/p/bob\n[*] Search completed with 2 results";
  assert.deepEqual(parseSherlockOutput(out, ["alice", "bob"]), [
    { username: "alice", site: "GitHub", url: "https://www.github.com/alice" },
    { username: "bob", site: "TryHackMe", url: "https://tryhackme.com/p/bob" },
  ]);
});

test("name matching works across Cyrillic/Latin and transliteration systems, but needs first + last name", () => {
  assert.ok(namesMatch("Ivan Petrov", "Петров Иван Сергеевич"));
  assert.ok(namesMatch("Alexey Khrushchev", "Хрущёв Алексей"));
  assert.ok(namesMatch("Aleksei Hrushchev", "Хрущёв Алексей"));
  assert.ok(!namesMatch("Ivan Sidorov", "Петров Иван"));
  assert.ok(!namesMatch("Ivan", "Петров Иван"));
  assert.deepEqual(nameSlugs("Петров Иван Сергеевич"), ["ivan-petrov", "petrov-ivan"]);
});

test("catalog recognizes vendor certificates but not training badges or other issuers", () => {
  assert.equal(matchCatalog("CompTIA Security+ ce Certification", "CompTIA").id, "comptia-security-plus");
  assert.equal(matchCatalog("Cisco Certified Network Associate (CCNA)", "Cisco").id, "cisco-ccna");
  assert.equal(matchCatalog("CCNA: Introduction to Networks", "Cisco"), null);
  assert.equal(matchCatalog("Security+ Exam Prep", "Udemy"), null);
  assert.equal(matchCatalog("CompTIA Security+", "Some Bootcamp"), null);
  assert.equal(parseBadgeUrl("https://www.credly.com/badges/1D51783C-7682-46d7-b762-20b642cba290/public_url"), "1d51783c-7682-46d7-b762-20b642cba290");
});

test("registration runs OSINT: Sherlock profiles + Credly badges verified by email hash, namesakes by name only", async () => {
  const email = uniqueEmail("osint");
  emails.push(email);
  const username = `found-${Date.now()}`;
  fakeCredly.addProfile(username, [
    { name: "CompTIA Security+ ce Certification", issuer: "CompTIA", issuedTo: "Ivan Petrov", recipientEmail: email },
    { name: "CCNA", issuer: "Cisco", issuedTo: "Ivan Petrov", recipientEmail: "other-address@example.com" },
    { name: "Random Badge", issuer: "Someone", issuedTo: "John Smith", recipientEmail: "john@example.com" },
  ]);
  const { cookie } = await registerPerson(baseUrl, { email, fullName: "Петров Иван Сергеевич", osintUsername: username });
  await waitForOsintIdle();

  const profile = await me(cookie);
  assert.equal(profile.osint.status, "done");
  assert.equal(profile.osint.sherlockAvailable, true);
  assert.ok(profile.osint.usernames.includes(username));
  assert.deepEqual(
    profile.osint.profiles.filter((p) => p.username === username).map((p) => p.site).sort(),
    ["GitHub", "HackTheBox"]
  );

  const byName = Object.fromEntries(profile.certificates.map((c) => [c.name, c]));
  assert.equal(byName["CompTIA Security+ ce Certification"].status, "verified");
  assert.equal(byName["CompTIA Security+ ce Certification"].catalogId, "comptia-security-plus");
  assert.equal(byName["CCNA"].status, "probable");
  // Профиль указан самим кандидатом, поэтому бейдж с чужим именем сохраняется — но как owner_mismatch.
  assert.equal(byName["Random Badge"].status, "owner_mismatch");
});

test("a Credly profile guessed from the name keeps only badges proven to be the candidate's", async () => {
  const email = uniqueEmail("osint-guess");
  emails.push(email);
  const stamp = Date.now().toString(36);
  const fullName = `Сидоров${stamp} Пётр`;
  const [slug] = nameSlugs(fullName);
  fakeCredly.addProfile(slug, [
    { name: "AWS Certified Security – Specialty", issuer: "Amazon Web Services Training and Certification", issuedTo: "Petr Sidorov", recipientEmail: email },
    { name: "CISSP", issuer: "ISC2", issuedTo: "Petr Sidorov", recipientEmail: "namesake@example.com" },
  ]);
  const { cookie } = await registerPerson(baseUrl, { email, fullName });
  await waitForOsintIdle();
  const profile = await me(cookie);
  assert.deepEqual(profile.certificates.map((c) => [c.catalogId, c.status]), [["aws-security-specialty", "verified"]]);
});

test("a claimed certificate is confirmed by its Credly badge link, or flagged when issued to someone else", async () => {
  const email = uniqueEmail("osint-claim");
  emails.push(email);
  const { cookie } = await registerPerson(baseUrl, { email, fullName: "Мария Иванова" });
  await waitForOsintIdle();
  const mine = fakeCredly.addBadge({ name: "CISSP", issuer: "ISC2", recipientEmail: email });
  const foreign = fakeCredly.addBadge({ name: "CISSP", issuer: "ISC2", recipientEmail: "someone@example.com" });

  const add = (url) =>
    fetch(`${baseUrl}/api/people/me/certificates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ catalogId: "isc2-cissp", url }),
    }).then((r) => r.json());

  assert.equal((await add(`https://www.credly.com/badges/${mine.id}/public_url`)).status, "verified");
  assert.equal((await add(`https://www.credly.com/badges/${foreign.id}`)).status, "owner_mismatch");
  assert.equal((await add("https://www.credly.com/badges/00000000-0000-0000-0000-000000000000")).status, "not_found");
});

test("reviewer sees certificates and OSINT in the report, can confirm a certificate, and a re-run does not override it", async () => {
  const email = uniqueEmail("osint-review");
  emails.push(email);
  const username = `found-rv-${Date.now()}`;
  fakeCredly.addProfile(username, [{ name: "CCNA", issuer: "Cisco", issuedTo: "Olga Kuznetsova", recipientEmail: "old@example.com" }]);
  const { cookie: personCookie } = await registerPerson(baseUrl, { email, fullName: "Кузнецова Ольга", osintUsername: username });
  const assessmentId = await startAssessment(baseUrl, personCookie);
  await waitForOsintIdle();
  const { cookie } = await loginReviewer(baseUrl);

  const report = await fetch(`${baseUrl}/api/assessments/${assessmentId}/report`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(report.assessment.osint_username, username);
  assert.equal(report.osint.status, "done");
  const ccna = report.certificates.find((c) => c.catalogId === "cisco-ccna");
  assert.equal(ccna.status, "probable");

  const review = await fetch(`${baseUrl}/api/assessments/${assessmentId}/certificates/${ccna.id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ status: "verified", note: "сверено по CertMetrics" }),
  });
  assert.equal(review.status, 200);

  const rerun = await fetch(`${baseUrl}/api/assessments/${assessmentId}/osint`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(rerun.status, 202);
  await waitForOsintIdle();

  const after = await fetch(`${baseUrl}/api/assessments/${assessmentId}/report`, { headers: { Cookie: cookie } }).then((r) => r.json());
  const ccnaAfter = after.certificates.find((c) => c.id === ccna.id);
  assert.equal(ccnaAfter.status, "verified");
  assert.equal(ccnaAfter.reviewed, true);
  assert.equal(after.osint.trigger, "reviewer");

  const list = await fetch(`${baseUrl}/api/assessments`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(list.find((a) => a.id === assessmentId).verified_certificates, 1);
  await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
});

test("OSINT still completes when the Sherlock binary is missing", async () => {
  const previous = process.env.SHERLOCK_BIN;
  process.env.SHERLOCK_BIN = "/nonexistent/sherlock";
  const email = uniqueEmail("osint-nosherlock");
  emails.push(email);
  try {
    const { cookie } = await registerPerson(baseUrl, { email, fullName: "Без Шерлока" });
    await waitForOsintIdle();
    const profile = await me(cookie);
    assert.equal(profile.osint.status, "done");
    assert.equal(profile.osint.sherlockAvailable, false);
    assert.match(profile.osint.error, /Sherlock не найден/);
  } finally {
    process.env.SHERLOCK_BIN = previous;
  }
});
