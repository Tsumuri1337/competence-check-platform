const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, pool } = require("../test-support/helpers");

let server, baseUrl;

test.before(async () => {
  ({ server, baseUrl } = await startTestServer());
});

test.after(async () => {
  server.close();
  await pool.end();
});

test("GET /api/standards lists all five profstandards", async () => {
  const res = await fetch(`${baseUrl}/api/standards`);
  assert.equal(res.status, 200);
  const standards = await res.json();
  const codes = standards.map((s) => s.code).sort();
  assert.deepEqual(codes, ["06.030", "06.032", "06.033", "06.034", "06.053"]);
});

test("GET /api/standards/:code returns full ОТФ/ТФ structure", async () => {
  const res = await fetch(`${baseUrl}/api/standards/06.030`);
  assert.equal(res.status, 200);
  const standard = await res.json();
  assert.equal(standard.code, "06.030");
  assert.ok(Array.isArray(standard.generalizedFunctions));
  assert.ok(standard.generalizedFunctions.length > 0);
  const firstGf = standard.generalizedFunctions[0];
  assert.ok(Array.isArray(firstGf.laborFunctions));
  assert.ok(firstGf.laborFunctions.length > 0);
  const firstLf = firstGf.laborFunctions[0];
  assert.ok(Array.isArray(firstLf.knowledge) || Array.isArray(firstLf.skills));
});

test("GET /api/standards/:code 404s for an unknown code", async () => {
  const res = await fetch(`${baseUrl}/api/standards/99.999`);
  assert.equal(res.status, 404);
});
