// Сравнение имён между кириллицей (как кандидат ввёл ФИО) и латиницей (как
// оно записано в Credly). Транслитерация упрощённая и «прощающая»: разные
// системы (Aleksei / Alexey / Aleksey) сводятся к одному скелету, а
// небольшие расхождения допускаются через расстояние Левенштейна.
const MAP = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

function transliterate(text) {
  return String(text)
    .toLowerCase()
    .split("")
    .map((ch) => (ch in MAP ? MAP[ch] : ch))
    .join("");
}

// Скелет токена: убираем различия систем транслитерации.
function skeleton(token) {
  return token
    .replace(/x/g, "ks")
    .replace(/kh/g, "h")
    .replace(/[yj]/g, "i")
    .replace(/ii/g, "i")
    .replace(/w/g, "v")
    .replace(/ph/g, "f")
    .replace(/(.)\1/g, "$1");
}

function tokens(name) {
  return transliterate(name)
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length >= 2)
    .map(skeleton);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function tokenMatches(a, b) {
  const allowed = Math.max(a.length, b.length) <= 5 ? 1 : 2;
  return levenshtein(a, b) <= allowed;
}

// Имена совпадают, если каждый токен более короткого имени (обычно Credly:
// «Ivan Petrov») находится в более длинном («Петров Иван Сергеевич») и
// совпавших токенов минимум два (имя + фамилия) — одной фамилии мало.
function namesMatch(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const matched = shorter.filter((t) => longer.some((u) => tokenMatches(t, u)));
  return matched.length === shorter.length && matched.length >= 2;
}

// «Петров Иван Сергеевич» -> ["ivan-petrov", "petrov-ivan"] — типичные
// vanity-адреса профиля Credly (credly.com/users/<slug>).
function nameSlugs(fullName) {
  const parts = transliterate(fullName)
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return [];
  const [last, first] = parts;
  return [`${first}-${last}`, `${last}-${first}`];
}

module.exports = { transliterate, namesMatch, nameSlugs };
