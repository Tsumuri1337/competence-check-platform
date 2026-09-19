const crypto = require("crypto");

// Шифрование ПДн (ФИО и email кандидатов/сотрудников) на уровне приложения:
// AES-256-GCM из встроенного crypto, без новых зависимостей. В БД лежит
// "enc:v1:<iv>:<tag>:<шифртекст>" (base64), поэтому дамп/бэкап базы сам по
// себе ПДн не раскрывает. Ключ — переменная PII_ENCRYPTION_KEY (32 байта в
// hex или base64); вне production при её отсутствии берётся фиксированный
// dev-ключ с предупреждением, в production сервер не стартует без ключа.
const PREFIX = "enc:v1:";
const DEV_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

function loadKey() {
  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PII_ENCRYPTION_KEY обязателен в production (32 байта, hex или base64)");
    }
    console.warn("[pii] PII_ENCRYPTION_KEY не задан — используется НЕБЕЗОПАСНЫЙ dev-ключ, только для локальной разработки");
    return Buffer.from(DEV_KEY_HEX, "hex");
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("PII_ENCRYPTION_KEY должен быть ровно 32 байта (hex из 64 символов или base64)");
  return key;
}

const KEY = loadKey();
// Отдельный ключ для blind index — компрометация одного не раскрывает другой.
const INDEX_KEY = Buffer.from(crypto.hkdfSync("sha256", KEY, Buffer.alloc(0), "pii-blind-index", 32));

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function decrypt(value) {
  if (!isEncrypted(value)) return value; // legacy plaintext до миграции
  const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

// Детерминированный хэш email для поиска/уникальности (шифртекст со
// случайным IV для этого не годится). Нормализуем регистр и пробелы.
function emailBlindIndex(email) {
  return crypto.createHmac("sha256", INDEX_KEY).update(String(email).trim().toLowerCase()).digest("hex");
}

module.exports = { encrypt, decrypt, emailBlindIndex, isEncrypted };
