const fs = require("fs");
const path = require("path");

const TOPICS_PATH = path.join(__dirname, "..", "content", "topics.json");

// «ё» и «е» в текстах вперемешку (вопросы теста пишут «защищённость»,
// стандарты — «защищенность»), поэтому и правила, и текст сводим к «е».
function normalize(text) {
  return String(text).replace(/ё/g, "е").replace(/Ё/g, "Е");
}

// В JS-регулярках \w и \b знают только ASCII, а тексты профстандартов —
// кириллица. Поэтому правила в topics.json пишутся в привычной нотации, а
// здесь \w заменяется на «любую букву/цифру Unicode», \b — на границу по
// тем же классам.
const WORD = "[\\p{L}\\p{N}_]";
function compilePattern(source) {
  const unicode = source
    .replace(/\\w/g, WORD)
    .replace(/\\b/g, `(?:(?<!${WORD})(?=${WORD})|(?<=${WORD})(?!${WORD}))`);
  return new RegExp(normalize(unicode), "iu");
}

function loadTopics() {
  const data = JSON.parse(fs.readFileSync(TOPICS_PATH, "utf8"));
  return {
    categories: data.categories,
    topics: data.topics.map((t) => ({ ...t, regexes: t.patterns.map(compilePattern) })),
  };
}

// Возвращает slug'и тем, к которым относится текст пункта.
function matchTopics(text, topics) {
  const normalized = normalize(text);
  return topics.filter((t) => t.regexes.some((re) => re.test(normalized))).map((t) => t.slug);
}

module.exports = { loadTopics, matchTopics, compilePattern, normalize };
