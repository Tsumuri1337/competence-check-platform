const fs = require("fs");
const path = require("path");

const TOPICS_PATH = path.join(__dirname, "..", "content", "topics.json");

// В JS-регулярках \w и \b знают только ASCII, а тексты профстандартов —
// кириллица. Поэтому правила в topics.json пишутся в привычной нотации, а
// здесь \w заменяется на «любую букву/цифру Unicode», \b — на границу по
// тем же классам.
const WORD = "[\\p{L}\\p{N}_]";
function compilePattern(source) {
  const unicode = source
    .replace(/\\w/g, WORD)
    .replace(/\\b/g, `(?:(?<!${WORD})(?=${WORD})|(?<=${WORD})(?!${WORD}))`);
  return new RegExp(unicode, "iu");
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
  return topics.filter((t) => t.regexes.some((re) => re.test(text))).map((t) => t.slug);
}

module.exports = { loadTopics, matchTopics, compilePattern };
