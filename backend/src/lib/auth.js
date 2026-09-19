const crypto = require("crypto");

// Хэширование пароля через scrypt (встроен в Node, без новых зависимостей).
// Формат хранения: "соль:хэш", оба в hex.
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Сессионный токен: случайные 32 байта в куке ревьюера, на сервере хранится
// только его sha256-хэш (как при хранении паролей — компрометация БД не
// раскрывает действующие токены).
function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = { hashPassword, verifyPassword, generateSessionToken, hashToken };
