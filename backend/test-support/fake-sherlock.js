#!/usr/bin/env node
// Подменный Sherlock для тестов (SHERLOCK_BIN): печатает вывод в формате
// настоящего `sherlock --print-found --no-color`. Никнеймы с префиксом
// "found-" «находятся» на GitHub и HackTheBox, остальные — нигде.
const usernames = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) break;
  usernames.push(arg);
}
for (const u of usernames) {
  console.log(`[*] Checking username ${u} on:\n`);
  if (u.startsWith("found-")) {
    console.log(`[+] GitHub: https://www.github.com/${u}`);
    console.log(`[+] HackTheBox: https://forum.hackthebox.com/u/${u}`);
  }
  console.log("");
}
console.log(`[*] Search completed with ${usernames.filter((u) => u.startsWith("found-")).length * 2} results`);
