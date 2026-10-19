// Фейковый Credly для тестов: те же пути и форма JSON, что у настоящего
// (см. src/lib/osint/credly.js), данные задаются тестом через addProfile().
const http = require("http");
const crypto = require("crypto");

function startFakeCredly() {
  const profiles = new Map(); // slug -> [badge]
  const badges = new Map(); // id -> badge

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let m = /^\/users\/([^/]+)\/badges\.json$/.exec(req.url);
    if (m) {
      const list = profiles.get(decodeURIComponent(m[1]));
      if (!list) return send(404, { data: { message: "Resource not found." } });
      return send(200, {
        data: list.map((b) => ({
          id: b.id,
          issued_to: b.issuedTo,
          issued_at_date: b.issuedOn || "2024-01-15",
          expires_at_date: null,
          badge_template: { name: b.name, skills: [{ name: "Security" }] },
          issuer: { summary: `issued by ${b.issuer}`, entities: [{ entity: { name: b.issuer } }] },
        })),
        metadata: { count: list.length },
      });
    }
    m = /^\/api\/v1\/obi\/v2\/badge_assertions\/([^/]+)$/.exec(req.url);
    if (m) {
      const b = badges.get(m[1]);
      if (!b) return send(404, {});
      const salt = "s4lt";
      return send(200, {
        badge: `https://www.credly.com/api/v1/obi/v2/issuers/i1/badge_classes/${b.id}`,
        recipient: {
          type: "email",
          hashed: true,
          salt,
          identity: "sha256$" + crypto.createHash("sha256").update(b.recipientEmail + salt).digest("hex"),
        },
      });
    }
    m = /^\/api\/v1\/obi\/v2\/issuers\/[^/]+\/badge_classes\/([^/]+)$/.exec(req.url);
    if (m) {
      const b = badges.get(m[1]);
      if (!b) return send(404, {});
      return send(200, { name: b.name, issuer: { name: b.issuer } });
    }
    send(404, {});
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({
        url: `http://localhost:${server.address().port}`,
        server,
        // badge: { name, issuer, issuedTo, recipientEmail }
        addProfile(slug, list) {
          const withIds = list.map((b) => ({ id: crypto.randomUUID(), ...b }));
          profiles.set(slug, withIds);
          for (const b of withIds) badges.set(b.id, b);
          return withIds;
        },
        addBadge(badge) {
          const b = { id: crypto.randomUUID(), ...badge };
          badges.set(b.id, b);
          return b;
        },
      });
    });
  });
}

module.exports = { startFakeCredly };
