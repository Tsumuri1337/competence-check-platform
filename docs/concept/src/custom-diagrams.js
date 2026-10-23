// Диаграммы с ручной раскладкой (SVG → PNG): UML use case и IDEF0 (A-0, A0).
const { chromium } = require("playwright");
const fs = require("fs");
const FONT = "Liberation Sans, Arial, sans-serif";
const INK = "#1b2430";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function text(x, y, lines, { size = 14, anchor = "middle", weight = 400, fill = INK, lh = 1.25 } = {}) {
  const arr = Array.isArray(lines) ? lines : [lines];
  const y0 = y - ((arr.length - 1) * size * lh) / 2;
  return arr.map((l, i) => `<text x="${x}" y="${y0 + i * size * lh}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="middle">${esc(l)}</text>`).join("");
}
const defs = `<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker>
<marker id="op" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M0,0 L11,6 L0,12" fill="none" stroke="${INK}" stroke-width="1.4"/></marker></defs>`;
const line = (pts, { arrow = false, dash = false, open = false, w = 1.4 } = {}) =>
  `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${INK}" stroke-width="${w}" ${dash ? 'stroke-dasharray="6 4"' : ""} ${arrow ? `marker-end="url(#${open ? "op" : "ar"})"` : ""}/>`;

// ---------- UML use case ----------
function stick(x, y, label) {
  return `<g stroke="${INK}" stroke-width="1.6" fill="none"><circle cx="${x}" cy="${y - 34}" r="11"/><line x1="${x}" y1="${y - 23}" x2="${x}" y2="${y + 8}"/><line x1="${x - 18}" y1="${y - 12}" x2="${x + 18}" y2="${y - 12}"/><line x1="${x}" y1="${y + 8}" x2="${x - 14}" y2="${y + 32}"/><line x1="${x}" y1="${y + 8}" x2="${x + 14}" y2="${y + 32}"/></g>` + text(x, y + 52, label, { size: 14, weight: 600 });
}
function usecase() {
  const W = 1200, H = 980;
  const SX = 200, SW = 800, SY = 40, SH = 760;
  const c1 = SX + 170, c2 = SX + SW - 170, ew = 290, eh = 52;
  const col1 = [
    ["u1", "Зарегистрироваться / войти"], ["u2", "Изучать требования в «Академии»"], ["u3", "Пройти проверку по должности"],
    ["u4", "Решить ситуационную задачу"], ["u5", "Заявить сертификат"], ["u6", "Просмотреть свой прогресс"],
    ["u11", "Вести банк задач и рубрик"],
  ];
  const col2 = [
    ["u7", "Оценить кейс-задание"], ["u8", "Подтвердить сертификат"], ["u9", "Сформировать AI-резюме"], ["u10", "Принять решение по кандидату"],
    ["u12", "Анализировать дефицит компетенций"], ["u13", "Сформировать план подготовки"], ["u14", "Управлять учётными записями и ролями"], ["u15", "Просматривать журнал доступа"],
  ];
  const pos = {};
  col1.forEach(([id], i) => (pos[id] = [c1, SY + 70 + i * 95]));
  col2.forEach(([id], i) => (pos[id] = [c2, SY + 70 + i * 86]));
  pos.u11[1] = SY + 70 + 6 * 95 + 20;
  let s = `<rect x="${SX}" y="${SY}" width="${SW}" height="${SH}" fill="#faf9f6" stroke="${INK}" stroke-width="1.5"/>` + text(SX + SW / 2, SY + 18, "Платформа проверки компетенций", { size: 15, weight: 700 });
  const ell = (id, label) => {
    const [x, y] = pos[id];
    const words = label.split(" "); let a = "", lines = [];
    for (const w of words) { if ((a + " " + w).trim().length > 24) { lines.push(a.trim()); a = w; } else a += " " + w; }
    lines.push(a.trim());
    return `<ellipse cx="${x}" cy="${y}" rx="${ew / 2}" ry="${eh / 2 + (lines.length > 1 ? 6 : 0)}" fill="#fff" stroke="${INK}" stroke-width="1.4"/>` + text(x, y, lines, { size: 13.5 });
  };
  const L = (x, y) => [x - ew / 2, y], R = (x, y) => [x + ew / 2, y];
  // акторы
  const actors = [
    ["Кандидат /", "сотрудник", 95, 300, ["u1", "u2", "u3", "u5", "u6"], "L"],
    ["Методист", null, 95, 640, ["u11", "u2"], "L"],
    ["Ревьюер", null, 1105, 200, ["u7", "u8", "u9", "u10"], "R"],
    ["Аналитик", "ОЦК", 1105, 480, ["u12", "u13"], "R"],
    ["Администратор", null, 1105, 690, ["u14", "u15"], "R"],
  ];
  let lines = "";
  for (const [a, b, x, y, ucs, side] of actors) {
    for (const u of ucs) {
      const [ux, uy] = pos[u];
      const end = side === "L" ? L(ux, uy) : R(ux, uy);
      lines += line([[side === "L" ? x + 22 : x - 22, y - 10], end]);
    }
  }
  // include
  const [x3, y3] = pos.u3, [x4, y4] = pos.u4;
  lines += line([[x3, y3 + eh / 2], [x4, y4 - eh / 2]], { arrow: true, dash: true, open: true }) + text(x3 + 62, (y3 + y4) / 2, "«include»", { size: 12.5 });
  // внешние системы
  const ext = (x, y, l) => `<rect x="${x - 115}" y="${y - 30}" width="230" height="60" fill="#fff" stroke="${INK}" stroke-dasharray="6 4" stroke-width="1.4"/>` + text(x, y, l, { size: 13.5 });
  const oy = SY + SH + 80;
  const [x5, y5] = pos.u5, [x9, y9] = pos.u9;
  const gx = SX + SW / 2;
  lines += line([[x5 + ew / 2, y5], [gx - 25, y5], [gx - 25, oy - 30]], { dash: true }) + text(gx - 25, y5 - 13, "«extend»", { size: 12.5 });
  lines += line([[x9 - ew / 2, y9], [gx + 25, y9], [gx + 25, oy - 30]], { dash: true });
  s += lines + ext(gx - 145, oy, ["«система» OSINT:", "Credly, Sherlock"]) + ext(gx + 145, oy, ["«система»", "AI-ассистент"]) + line([[gx - 25, oy - 30], [gx - 25, oy - 30]]);
  // поправка: внешние ящики соединены с вертикалями

  for (const [id, l] of [...col1, ...col2]) s += ell(id, l);
  for (const [a, b, x, y] of actors) s += stick(x, y, b ? [a, b] : [a]);
  return { W, H, body: s };
}

// ---------- IDEF0 ----------
function box(x, y, w, h, title, code) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="${INK}" stroke-width="2"/>` + text(x + w / 2, y + h / 2 - 4, title, { size: 14, weight: 600 }) + text(x + w - 8, y + h - 12, code, { size: 12, anchor: "end" });
}
function frame(W, H, node, title, num) {
  const fy = H - 46;
  return `<rect x="10" y="10" width="${W - 20}" height="${H - 20}" fill="none" stroke="${INK}" stroke-width="1.2"/>` +
    `<line x1="10" y1="${fy}" x2="${W - 10}" y2="${fy}" stroke="${INK}"/>` +
    `<line x1="200" y1="${fy}" x2="200" y2="${H - 10}" stroke="${INK}"/><line x1="${W - 200}" y1="${fy}" x2="${W - 200}" y2="${H - 10}" stroke="${INK}"/>` +
    text(20, fy + 18, "УЗЕЛ:", { size: 10, anchor: "start" }) + text(105, fy + 22, node, { size: 15, weight: 700 }) +
    text(210, fy + 18, "НАЗВАНИЕ:", { size: 10, anchor: "start" }) + text(W / 2, fy + 22, title, { size: 14, weight: 600 }) +
    text(W - 190, fy + 18, "НОМЕР:", { size: 10, anchor: "start" }) + text(W - 105, fy + 22, num, { size: 14 });
}
function idefA_0() {
  const W = 1150, H = 640;
  const bx = 400, by = 230, bw = 350, bh = 170;
  let s = box(bx, by, bw, bh, ["Проводить оценку", "компетенций специалистов", "по информационной безопасности"], "A0");
  const ins = ["Данные кандидата / сотрудника", "Ответы на задания", "Заявленные сертификаты"];
  ins.forEach((t, i) => { const y = by + 45 + i * 40; s += line([[60, y], [bx, y]], { arrow: true }) + text(70, y - 11, t, { size: 12.5, anchor: "start" }); });
  const outs = ["Итоговая оценка 0–100", "Отчёт и AI-резюме по кандидату", "Решение по кандидату", "Аналитика дефицита кадров (ОЦК)"];
  outs.forEach((t, i) => { const y = by + 32 + i * 36; s += line([[bx + bw, y], [W - 50, y]], { arrow: true }) + text(bx + bw + 12, y - 11, t, { size: 12.5, anchor: "start" }); });
  const ctr = ["Профстандарты 06.030–06.053", "Положение об ОЦК", "Методика оценки, рубрики", "152-ФЗ (защита ПДн)"];
  ctr.forEach((t, i) => { const x = bx + 45 + i * 87; s += line([[x, 70 + i * 26], [x, by]], { arrow: true }) + text(x + 6, 62 + i * 26, t, { size: 12.5, anchor: i > 1 ? "start" : "start" }); });
  const mech = ["Платформа (ПО, БД)", "Ревьюеры, методисты", "AI-ассистент", "OSINT (Credly, Sherlock)"];
  mech.forEach((t, i) => { const x = bx + 45 + i * 87; s += line([[x, H - 90 - i * 22], [x, by + bh]], { arrow: true }) + text(x + 6, H - 82 - i * 22, t, { size: 12.5, anchor: "start" }); });
  s += frame(W, H, "A-0", "Проводить оценку компетенций специалистов ИБ", "1");
  return { W, H, body: s };
}
function idefA0() {
  const W = 1560, H = 1080;
  const bw = 200, bh = 96;
  const boxes = [
    ["A1", ["Вести банк задач", "и требований"], 60, 120],
    ["A2", ["Зарегистрировать,", "проверить сертификаты"], 310, 250],
    ["A3", ["Провести", "проверку"], 560, 380],
    ["A4", ["Оценить", "результаты"], 810, 510],
    ["A5", ["Подготовить отчёт", "и решение"], 1060, 640],
    ["A6", ["Сформировать", "аналитику ОЦК"], 1140, 830],
  ];
  const B = Object.fromEntries(boxes.map(([c, , x, y]) => [c, { x, y, r: x + bw, b: y + bh }]));
  let s = "";
  const A = (pts) => (s += line(pts, { arrow: true }));
  const T = (x, y, t, anchor = "start") => (s += text(x, y, t, { size: 12, anchor }));
  // A1 → A3 (управление): банк задач
  A([[B.A1.r, 160], [B.A3.x + 30, 160], [B.A3.x + 30, B.A3.y]]); T(B.A1.r + 10, 148, "банк задач (управление)");
  // A2 → A4: подтверждённые сертификаты
  A([[B.A2.r, 290], [785, 290], [785, B.A4.y + 70], [B.A4.x, B.A4.y + 70]]); T(B.A2.r + 8, 278, "подтверждённые сертификаты");
  // A2 → A3: учётная запись
  A([[B.A2.r, 330], [535, 330], [535, B.A3.y + 30], [B.A3.x, B.A3.y + 30]]); T(598, 352, "учётная запись");
  // внешние входы
  A([[22, B.A2.y + 48], [B.A2.x, B.A2.y + 48]]); T(40, B.A2.y + 36, "данные кандидата");
  A([[22, B.A3.y + 70], [B.A3.x, B.A3.y + 70]]); T(40, B.A3.y + 58, "ответы на задания");
  // A3 → A4: ответы, время
  A([[B.A3.r, B.A3.y + 40], [800, B.A3.y + 40], [800, B.A4.y + 30], [B.A4.x, B.A4.y + 30]]); T(808, B.A3.y + 92, "ответы, время");
  // A4 → A5: итоговая оценка
  A([[B.A4.r, B.A4.y + 40], [1050, B.A4.y + 40], [1050, B.A5.y + 40], [B.A5.x, B.A5.y + 40]]); T(B.A4.r + 6, B.A4.y + 28, "итоговая оценка");
  // A4 → A6: оценки (агрегаты)
  A([[B.A4.r, B.A4.y + 80], [1030, B.A4.y + 80], [1030, B.A6.y + 48], [B.A6.x, B.A6.y + 48]]); T(1038, B.A6.y + 36, "агрегаты");
  // выходы
  A([[B.A5.r, B.A5.y + 30], [W - 30, B.A5.y + 30]]); T(B.A5.r + 8, B.A5.y + 18, "отчёт, AI-резюме");
  A([[B.A5.r, B.A5.y + 70], [W - 30, B.A5.y + 70]]); T(B.A5.r + 8, B.A5.y + 58, "решение по кандидату");
  A([[B.A6.r, B.A6.y + 48], [W - 30, B.A6.y + 48]]); T(B.A6.r + 8, B.A6.y + 36, "аналитика, план подготовки");
  // обратная связь A6 → A1 (управление)
  A([[B.A6.x + 100, B.A6.b], [B.A6.x + 100, B.A6.b + 50], [35, B.A6.b + 50], [35, 60], [B.A1.x + 100, 60], [B.A1.x + 100, B.A1.y]]);
  T(50, 48, "потребности в подготовке → корректировка банка задач (обратная связь)");
  // управления (сверху)
  for (const [c, t] of [["A1", "профстандарты"], ["A2", "152-ФЗ, согласие"], ["A4", "методика, рубрики"], ["A6", "Положение об ОЦК"]]) {
    const b = B[c], x = b.r - 40; A([[x, b.y - 42], [x, b.y]]); T(x + 6, b.y - 32, t);
  }
  // механизмы (снизу)
  for (const [c, t, left] of [["A1", "методисты"], ["A2", "OSINT"], ["A3", "платформа", 1], ["A4", "ревьюеры, AI", 1], ["A5", "ревьюеры"]]) {
    const b = B[c], x = b.r - 40; A([[x, b.b + 40], [x, b.b]]); left ? T(x - 6, b.b + 32, t, "end") : T(x + 6, b.b + 32, t);
  }
  for (const [code, title, x, y] of boxes) s += box(x, y, bw, bh, title, code);
  s += frame(W, H, "A0", "Проводить оценку компетенций специалистов ИБ (декомпозиция)", "2");
  return { W, H, body: s };
}


// ---------- UML deployment ----------
function node3d(x, y, w, h, title) {
  const d = 14;
  return `<path d="M${x},${y} l${d},-${d} h${w} v${h} l-${d},${d}" fill="#f3f1ec" stroke="${INK}" stroke-width="1.5"/><line x1="${x + w}" y1="${y}" x2="${x + w + d}" y2="${y - d}" stroke="${INK}" stroke-width="1.5"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#faf9f6" stroke="${INK}" stroke-width="1.5"/>` + text(x + 12, y + 20, title, { size: 13.5, weight: 700, anchor: "start" });
}
function art(x, y, w, h, lines, dashed = false) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="${INK}" stroke-width="1.3" ${dashed ? 'stroke-dasharray="6 4"' : ""}/>` + text(x + w / 2, y + h / 2, lines, { size: 13 });
}
function deployment() {
  const W = 1180, H = 600;
  let s = "";
  s += node3d(30, 220, 230, 140, "«устройство» Рабочее место");
  s += art(55, 262, 180, 70, ["«артефакт» Браузер", "веб-клиент (HTML/JS)"]);
  s += node3d(330, 50, 520, 500, "«узел» Сервер в ЦОД на территории РФ");
  s += art(360, 100, 220, 70, ["«исп. среда» Обратный прокси", "TLS 1.2+, лимит запросов"]);
  s += art(360, 255, 220, 70, ["«исп. среда» Node.js 22", "API + раздача страниц"]);
  s += art(360, 430, 220, 80, ["«узел» PostgreSQL 16", "контент, проверки,", "ПДн (шифр.), резервные копии"]);
  s += art(620, 200, 200, 60, ["«артефакт» Sherlock CLI"]);
  s += art(620, 320, 200, 70, ["«хранилище» ключ шифрования", "ПДн (KMS): чтение ключа"]);
  s += node3d(910, 150, 240, 330, "«внешние сервисы»");
  s += art(935, 200, 190, 70, ["Credly", "(публичные бейджи)"], true);
  s += art(935, 385, 190, 70, ["Claude API", "(опционально)"], true);
  const L = (pts, lbl, lx, ly, o = {}) => { s += line(pts, { arrow: true, ...o }); if (lbl) s += text(lx, ly, lbl, { size: 12, anchor: "start" }); };
  L([[235, 297], [290, 297], [290, 135], [360, 135]], null); s += text(284, 195, "HTTPS 443", { size: 12, anchor: "end" });
  L([[470, 170], [470, 255]], "HTTP (localhost)", 478, 212);
  L([[470, 325], [470, 430]], "TCP 5432", 478, 378);
  L([[580, 280], [600, 280], [600, 230], [620, 230]], "запуск", 586, 210);
  L([[580, 300], [600, 300], [600, 355], [620, 355]], null, 0, 0, { dash: true });
  L([[580, 290], [880, 290], [880, 235], [935, 235]], "HTTPS (исходящие)", 700, 278);
  L([[580, 315], [608, 315], [608, 420], [935, 420]], "HTTPS, обезличенные данные", 640, 438);
  return { W, H, body: s };
}

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await b.newPage({ deviceScaleFactor: 2.5 });
  for (const [name, fn] of [["u1-usecase", usecase], ["i1-idef0-A-0", idefA_0], ["i2-idef0-A0", idefA0], ["u8-deployment", deployment]]) {
    const { W, H, body } = fn();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}<rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await page.screenshot({ path: `diagrams/${name}.png`, clip: { x: 0, y: 0, width: W, height: H } });
    console.log("ok", name);
  }
  await b.close();
})();
