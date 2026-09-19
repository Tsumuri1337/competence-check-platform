// Минимальный парсер Cookie-заголовка — отдельная зависимость (cookie-parser)
// не нужна для одной сессионной куки.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

const SESSION_COOKIE = "reviewer_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 дней

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

module.exports = { parseCookies, setSessionCookie, clearSessionCookie, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS };
