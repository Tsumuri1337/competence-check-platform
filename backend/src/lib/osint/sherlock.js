const { execFile } = require("child_process");

// Sherlock (https://github.com/sherlock-project/sherlock, MIT) — поиск
// аккаунтов по никнейму на ~400 сайтах. Запускаем как внешний процесс,
// ограничив список сайтами, значимыми для ИБ-специалиста: платформы
// практики (HTB, THM, CryptoHack), баг-баунти, код, профили сертификатов.
// Установка: `pipx install sherlock-project` (или pip). Путь к бинарнику —
// SHERLOCK_BIN (по умолчанию "sherlock" из PATH); сайты с частыми ложными
// срабатываниями (например, Reddit) из списка исключены, но и остальные
// результаты — «возможные» профили, ревьюер открывает их перед выводами; если его нет, OSINT
// продолжается без Sherlock, а в отчёте помечается, что он недоступен.
const SECURITY_SITES = [
  "GitHub", "GitLab", "BitBucket", "HackTheBox", "TryHackMe", "HackerOne", "BugCrowd", "HackenProof (Hackers)",
  "PentesterLab", "CryptoHack", "Credly", "AWS Skills Profile", "Docker Hub", "Keybase", "LeetCode", "Codeforces",
  "HackerRank", "Kaggle", "Medium", "habr", "Career.habr", "LinkedIn", "Telegram", "PyPi", "npm",
];

const RUN_TIMEOUT_MS = 180000;
const USERNAME_RE = /^[A-Za-z0-9._-]{2,40}$/;

// Разбирает вывод `sherlock --print-found --no-color`:
//   [*] Checking username alice on:
//   [+] GitHub: https://www.github.com/alice
function parseSherlockOutput(stdout, usernames) {
  const profiles = [];
  let current = usernames.length === 1 ? usernames[0] : null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const checking = /^\[\*\] Checking username (\S+) on:/.exec(line);
    if (checking) {
      current = checking[1];
      continue;
    }
    const found = /^\[\+\] ([^:]+): (https?:\/\/\S+)/.exec(line);
    if (found && current) profiles.push({ username: current, site: found[1].trim(), url: found[2] });
  }
  return profiles;
}

function runSherlock(usernames) {
  const valid = usernames.filter((u) => USERNAME_RE.test(u));
  if (!valid.length) return Promise.resolve({ available: true, profiles: [], error: null });
  const bin = process.env.SHERLOCK_BIN || "sherlock";
  const args = [
    ...valid,
    "--print-found",
    "--no-color",
    "--local",
    "--timeout",
    "10",
    ...SECURITY_SITES.flatMap((s) => ["--site", s]),
  ];
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && err.code === "ENOENT") {
        resolve({ available: false, profiles: [], error: `Sherlock не найден (${bin}) — установите sherlock-project или задайте SHERLOCK_BIN` });
        return;
      }
      const profiles = parseSherlockOutput(stdout, valid);
      // Ненулевой код или таймаут — отдаём то, что успели найти, с пометкой.
      resolve({ available: true, profiles, error: err ? `Sherlock завершился с ошибкой: ${err.message}` : null });
    });
  });
}

module.exports = { runSherlock, parseSherlockOutput, SECURITY_SITES, USERNAME_RE };
