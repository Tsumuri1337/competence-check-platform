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

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200; // потолок, чтобы огромный "пароль" не жёг CPU в scrypt

// Возвращает текст ошибки или null, если пароль подходит.
function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Пароль должен быть не длиннее ${MAX_PASSWORD_LENGTH} символов`;
  if (new Set(password).size < 4) return "Пароль слишком простой";
  return null;
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

module.exports = { hashPassword, verifyPassword, generateSessionToken, hashToken, validatePasswordStrength, MAX_PASSWORD_LENGTH };
