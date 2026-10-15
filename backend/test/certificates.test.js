const test = require("node:test");
const assert = require("node:assert/strict");
const {
  startTestServer,
  uniqueEmail,
  loginReviewer,
  registerParticipant,
  fetchAs,
  cleanupAssessment,
  cleanupPerson,
  pool,
} = require("../test-support/helpers");
const { issuers } = require("../src/lib/certificateIssuers");
const { loadTaxonomy } = require("../src/lib/competences");

let server, baseUrl, reviewerCookie;
const emails = [];
const assessmentIds = [];

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
  ({ cookie: reviewerCookie } = await loginReviewer(baseUrl));
});

test.after(async () => {
  for (const id of assessmentIds) await cleanupAssessment(id);
  for (const email of emails) await cleanupPerson(email);
  await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { Cookie: reviewerCookie } });
  server.close();
  await pool.end();
});

async function newParticipant(prefix) {
  const email = uniqueEmail(prefix);
  emails.push(email);
  const { cookie, participant } = await registerParticipant(baseUrl, { email });
  return { email, cookie, participant, api: fetchAs(cookie) };
}

function send(api, method, path, body) {
  return api(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const CCNA = { issuer: "cisco", certification: "CCNA", holderName: "Ivan Petrov", credentialId: "ABC-123-XYZ" };

test("the issuer catalog only references existing competence areas and standards", () => {
  const slugs = new Set(loadTaxonomy().map((c) => c.slug));
  const standards = new Set(["06.030", "06.032", "06.033", "06.034", "06.053"]);
  for (const issuer of issuers) {
    assert.ok(["latin", "cyrillic"].includes(issuer.nameScript), issuer.slug);
    for (const c of issuer.certifications) {
      for (const s of c.competences) assert.ok(slugs.has(s), `${issuer.slug}/${c.name}: ${s}`);
      for (const s of c.standards || []) assert.ok(standards.has(s), `${issuer.slug}/${c.name}: ${s}`);
    }
  }
});

test("GET /api/certificate-issuers lists issuers with what to ask for, but not reviewer instructions", async () => {
  const list = await fetch(`${baseUrl}/api/certificate-issuers`).then((r) => r.json());
  const cisco = list.find((i) => i.slug === "cisco");
  assert.equal(cisco.nameScript, "latin");
  assert.ok(cisco.credentialLabel);
  assert.ok(cisco.certifications.find((c) => c.name === "CCNA").competences.some((c) => c.slug === "network-security"));
  assert.equal("verifyUrl" in cisco, false);
});

test("the Latin name is saved to the profile and validated", async () => {
  const { api } = await newParticipant("latin");
  assert.equal((await send(api, "PATCH", "/api/participant/profile", { nameLatin: "Иван" })).status, 400);
  const ok = await send(api, "PATCH", "/api/participant/profile", { nameLatin: "Ivan Petrov" });
  assert.equal(ok.status, 200);
  const me = await api(`${baseUrl}/api/participant/me`).then((r) => r.json());
  assert.equal(me.nameLatin, "Ivan Petrov");
});

test("adding a certificate validates the name script, dates and badge link", async () => {
  const { api } = await newParticipant("certval");
  assert.equal((await send(fetch, "POST", "/api/participant/certificates", CCNA)).status, 401);
  const bad = [
    { ...CCNA, issuer: "nope" },
    { ...CCNA, holderName: "Иван Петров" }, // Cisco печатает имя латиницей
    { ...CCNA, credentialId: "" },
    { ...CCNA, issuedOn: "2024-13-01" },
    { ...CCNA, issuedOn: "2024-05-01", expiresOn: "2023-05-01" },
    { ...CCNA, badgeUrl: "javascript:alert(1)" },
    { issuer: "nok", certification: "Квалификация по профстандарту 06.032", holderName: "Ivan Petrov", credentialId: "06.03200.01" },
  ];
  for (const body of bad) {
    const res = await send(api, "POST", "/api/participant/certificates", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("a certificate is stored encrypted, mapped to competence areas and deduplicated by number", async () => {
  const { api, participant } = await newParticipant("certok");
  const res = await send(api, "POST", "/api/participant/certificates", { ...CCNA, issuedOn: "2020-01-01", expiresOn: "2023-01-01" });
  assert.equal(res.status, 201);
  const cert = await res.json();
  assert.equal(cert.verificationStatus, "pending");
  assert.equal(cert.holderName, "Ivan Petrov");
  assert.equal(cert.expired, true);
  assert.ok(cert.competences.some((c) => c.slug === "network-security"));

  const { rows } = await pool.query("SELECT holder_name, credential_id FROM participant_certificates WHERE id = $1", [cert.id]);
  assert.ok(rows[0].holder_name.startsWith("enc:v1:"));
  assert.ok(rows[0].credential_id.startsWith("enc:v1:"));

  // Тот же номер в другом написании — дубликат.
  const dup = await send(api, "POST", "/api/participant/certificates", { ...CCNA, credentialId: "abc 123 xyz" });
  assert.equal(dup.status, 409);

  const nok = await send(api, "POST", "/api/participant/certificates", {
    issuer: "nok",
    certification: "Квалификация по профстандарту 06.032",
    holderName: "Петров Иван Сергеевич",
    credentialId: "06.03200.01-12345",
  });
  assert.equal(nok.status, 201);
  assert.deepEqual((await nok.json()).standards, ["06.032"]);

  const list = await api(`${baseUrl}/api/participant/certificates`).then((r) => r.json());
  assert.equal(list.length, 2);
  assert.ok(participant.id);
});

test("a participant can only delete their own certificates", async () => {
  const owner = await newParticipant("certown");
  const other = await newParticipant("certother");
  const cert = await send(owner.api, "POST", "/api/participant/certificates", { ...CCNA, credentialId: "OWN-1" }).then((r) => r.json());
  assert.equal((await send(other.api, "DELETE", `/api/participant/certificates/${cert.id}`)).status, 404);
  assert.equal((await send(owner.api, "DELETE", `/api/participant/certificates/${cert.id}`)).status, 200);
});

test("the reviewer report shows certificates with how to verify them, and the reviewer records the result", async () => {
  const { api } = await newParticipant("certrev");
  const cert = await send(api, "POST", "/api/participant/certificates", { ...CCNA, credentialId: "SHARED-777" }).then((r) => r.json());
  // Кто-то ещё заявил тот же номер — ревьюер должен это видеть.
  const copycat = await newParticipant("certcopy");
  await send(copycat.api, "POST", "/api/participant/certificates", { ...CCNA, credentialId: "shared-777" });

  const start = await send(api, "POST", "/api/assessments", { standardCode: "06.032" }).then((r) => r.json());
  assessmentIds.push(start.assessmentId);
  const reviewer = fetchAs(reviewerCookie);

  const report = await reviewer(`${baseUrl}/api/assessments/${start.assessmentId}/report`).then((r) => r.json());
  assert.equal(report.certificates.length, 1);
  const shown = report.certificates[0];
  assert.equal(shown.credentialId, "SHARED-777");
  assert.equal(shown.holderName, "Ivan Petrov");
  assert.equal(shown.sameNumberElsewhere, 1);
  assert.ok(shown.verify.url.startsWith("https://"));
  assert.ok(shown.competences.find((c) => c.slug === "network-security").relevantToStandard);
  assert.equal(report.summary.certificatesTotal, 1);

  const path = `/api/assessments/${start.assessmentId}/certificates/${cert.id}/verification`;
  assert.equal((await send(fetch, "POST", path, { status: "verified" })).status, 401);
  assert.equal((await send(reviewer, "POST", path, { status: "maybe" })).status, 400);

  // Сертификат чужого человека через эту проверку не отметить.
  const copycatCert = (await copycat.api(`${baseUrl}/api/participant/certificates`).then((r) => r.json()))[0];
  const wrong = await send(reviewer, "POST", `/api/assessments/${start.assessmentId}/certificates/${copycatCert.id}/verification`, { status: "verified" });
  assert.equal(wrong.status, 404);

  const ok = await send(reviewer, "POST", path, { status: "verified", note: "Проверено на cisco.com" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).verificationStatus, "verified");

  const mine = await api(`${baseUrl}/api/participant/certificates`).then((r) => r.json());
  assert.equal(mine[0].verificationStatus, "verified");

  const { rows } = await pool.query("SELECT count(*)::int AS n FROM access_log WHERE assessment_id = $1 AND action = 'verify_certificate'", [
    start.assessmentId,
  ]);
  assert.equal(rows[0].n, 1);
});
