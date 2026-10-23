// Низкодетализированные макеты экранов (wireframes): серые блоки, единая оболочка.
const { chromium } = require("playwright");
const CSS = `
*{box-sizing:border-box} body{margin:0;font-family:'Liberation Sans',Arial,sans-serif;color:#222;background:#fff;font-size:13px}
.top{height:52px;border-bottom:2px solid #333;display:flex;align-items:center;padding:0 18px;gap:22px;background:#f2f2f2}
.logo{font-weight:700;font-size:15px;margin-right:18px} .tab{color:#555;padding:16px 2px;border-bottom:3px solid transparent}
.tab.on{color:#000;font-weight:700;border-bottom-color:#000} .sp{flex:1}
.role{border:2px solid #333;border-radius:14px;padding:4px 12px;font-weight:700;background:#fff}
.av{width:28px;height:28px;border-radius:50%;background:#bbb}
.wrap{display:flex;height:calc(100% - 52px)} .side{width:220px;border-right:1px solid #ccc;padding:14px;background:#fafafa}
.side h4{margin:6px 0 8px;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em}
.si{padding:7px 8px;border-radius:4px;margin-bottom:2px;color:#444} .si.on{background:#ddd;font-weight:700;color:#000}
.main{flex:1;padding:20px 24px;overflow:hidden} .rt{width:250px;border-left:1px solid #ccc;padding:16px;background:#fafafa}
h1{font-size:20px;margin:0 0 6px} h2{font-size:15px;margin:16px 0 8px} .muted{color:#777}
.box{border:1.5px solid #999;border-radius:6px;padding:12px;margin-bottom:12px;background:#fff}
.ph{background:repeating-linear-gradient(45deg,#eee,#eee 6px,#e3e3e3 6px,#e3e3e3 12px);border:1px dashed #aaa;border-radius:4px}
.line{height:9px;background:#d5d5d5;border-radius:4px;margin:7px 0} .w60{width:60%}.w80{width:80%}.w40{width:40%}.w90{width:90%}
.lvl{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border:1.5px solid #333;border-radius:3px;letter-spacing:.04em}
.lvl.b{background:#fff}.lvl.s{background:#ddd}.lvl.e{background:#333;color:#fff}
.st{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid #888}.st.ok{background:#333;color:#fff;border-color:#333}
.btn{display:inline-block;border:2px solid #333;border-radius:4px;padding:7px 14px;font-weight:700;background:#fff}.btn.p{background:#333;color:#fff}
.row{display:flex;gap:12px;align-items:center} .grid{display:grid;gap:10px}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #ccc;padding:7px 6px;text-align:left;font-size:12.5px} th{font-size:11px;color:#666;text-transform:uppercase}
.chip{display:inline-block;border:1px solid #888;border-radius:12px;padding:2px 9px;margin:2px;font-size:11.5px}
.note{position:absolute;background:#fff3b0;border:1.5px solid #b59b00;border-radius:4px;padding:5px 8px;font-size:11.5px;max-width:230px;box-shadow:2px 2px 0 #b59b00}
.num{display:inline-flex;width:20px;height:20px;border-radius:50%;background:#b59b00;color:#fff;font-weight:700;font-size:11px;align-items:center;justify-content:center;margin-right:5px}
.heat td{text-align:center;font-weight:700;font-size:11.5px}
.bar{height:10px;background:#e3e3e3;border-radius:5px;overflow:hidden}.bar>i{display:block;height:100%;background:#555}
`;
const top = (tabs, active, role) => `<div class="top"><span class="logo">◼ Проверка компетенций</span>${tabs.map((t) => `<span class="tab ${t === active ? "on" : ""}">${t}</span>`).join("")}<span class="sp"></span><span class="role">Вы вошли как: ${role} ▾</span><span class="av"></span></div>`;
const T_CAND = ["Академия", "Задачи", "Кабинет", "Мои проверки"];
const T_REV = ["Академия", "Задачи", "Ревьюер"];
const T_AN = ["Академия", "Аналитика ОЦК"];
const T_MET = ["Академия", "Задачи", "Методист"];
const note = (n, x, y, t) => `<div class="note" style="left:${x}px;top:${y}px"><span class="num">${n}</span>${t}</div>`;

const pages = {
"w1-academy": `${top(T_CAND, "Академия", "Кандидат")}<div class="wrap">
<div class="side"><h4>Траектории</h4><div class="si">06.030 Телеком</div><div class="si on">06.032 Компьютерные системы</div><div class="si">06.033 Автоматизир. системы</div><div class="si">06.034 ТЗИ</div><div class="si">06.053 Кредитно-фин. сфера</div>
<h4 style="margin-top:16px">Темы траектории</h4><div class="si">Компьютерные сети</div><div class="si on">Криптография и СКЗИ</div><div class="si">Межсетевые экраны</div><div class="si">Инциденты</div><div class="si">SIEM и мониторинг</div><div class="si muted">… ещё 20</div></div>
<div class="main"><div class="muted">Академия › 06.032 › Темы</div><h1>Криптография и СКЗИ</h1><div class="line w90"></div><div class="line w80"></div><div class="line w60"></div>
<h2>Где требуется в должности</h2><div class="box"><b>B/01.6</b> Разработка требований к программно-аппаратным средствам… <span class="chip">4 знания</span><span class="chip">1 умение</span><br><b style="display:inline-block;margin-top:8px">B/02.6</b> Проектирование программно-аппаратных средств… <span class="chip">3 знания</span></div>
<h2>Задачи по теме</h2><div class="grid" style="grid-template-columns:1fr 1fr">
<div class="box"><span class="lvl b">БАЗОВЫЙ</span> <span class="st ok">Решено</span><div style="margin-top:8px;font-weight:700">Компрометация ключа ЭП</div><div class="line w80"></div></div>
<div class="box"><span class="lvl s">СПЕЦИАЛИСТ</span> <span class="st">Не решено</span><div style="margin-top:8px;font-weight:700">Выбор СКЗИ для канала АСУ ТП</div><div class="line w60"></div></div>
<div class="box"><span class="lvl e">ЭКСПЕРТ</span> <span class="st">Не решено</span><div style="margin-top:8px;font-weight:700">Ошибка в настройке TLS шлюза</div><div class="line w80"></div></div>
<div class="box"><span class="lvl s">СПЕЦИАЛИСТ</span> <span class="st">Не решено</span><div style="margin-top:8px;font-weight:700">Порядок смены ключей</div><div class="line w40"></div></div></div></div>
<div class="rt"><b>Ваш прогресс по теме</b><div style="font-size:30px;font-weight:700;margin:8px 0">1 / 4</div><div class="bar"><i style="width:25%"></i></div><h2>Сертификаты по теме</h2><span class="chip">CISSP</span><span class="chip">Security+</span><span class="chip">HCIA-Security</span></div></div>
${note(1, 760, 8, "Вкладки зависят от роли: кандидат не видит «Ревьюер»")}${note(2, 20, 530, "Боковая навигация раздела — как в PortSwigger Academy")}${note(3, 1000, 250, "Прогресс всегда на виду")}`,

"w2-catalog": `${top(T_CAND, "Задачи", "Кандидат")}<div class="wrap">
<div class="side"><h4>Фильтры</h4><div class="box"><b>Уровень</b><div>☑ Базовый</div><div>☑ Специалист</div><div>☐ Эксперт</div></div><div class="box"><b>Должность</b><div>06.032 ▾</div></div><div class="box"><b>Направление ОЦК</b><div>Реагирование на атаки ▾</div></div><div class="box"><b>Статус</b><div>☐ Только нерешённые</div></div></div>
<div class="main"><div class="row"><h1 style="flex:1">Все задачи <span class="muted" style="font-size:14px">· 124 задачи</span></h1><div class="box" style="width:300px;margin:0">🔍 Поиск по задачам…</div></div>
<table><tr><th>Задача</th><th>Тема</th><th>Компетенция</th><th>Уровень</th><th>Статус</th></tr>
${[["Ночной всплеск трафика с АРМ инженера АСУ ТП","Инциденты","A/01.5","b","Решено"],["Фишинговое письмо руководителю","Атаки","A/02.5","b","Решено"],["Неверная цепочка правил МЭ","Межсетевые экраны","A/02.5","s",""],["Подозрительное поведение бизнес-приложения","Вредоносное ПО","B/01.6","s",""],["Утечка через USB на объекте КИИ","КИИ","B/03.6","s",""],["Компрометация учётной записи администратора","Доступ","C/01.7","e",""],["Анализ журнала SIEM: латеральное перемещение","SIEM","C/02.7","e",""],["Оценка рисков нового сегмента сети","Риски","D/01.7","e",""]].map(([t,tp,c,l,s])=>`<tr><td><b>${t}</b></td><td>${tp}</td><td>${c}</td><td><span class="lvl ${l}">${{b:"БАЗОВЫЙ",s:"СПЕЦИАЛИСТ",e:"ЭКСПЕРТ"}[l]}</span></td><td>${s?`<span class="st ok">${s}</span>`:`<span class="st">—</span>`}</td></tr>`).join("")}
</table></div></div>${note(1, 20, 400, "Фильтры: уровень, должность, направление ОЦК, статус")}${note(2, 380, 420, "Уровни: Базовый (5–6), Специалист (7), Эксперт (8)")}`,

"w3-task": `${top(T_CAND, "Мои проверки", "Кандидат")}<div class="wrap">
<div class="main" style="flex:1.1;border-right:1px solid #ccc"><div class="muted">Проверка 06.032 · задача 3 из 6</div><h1>Ночной всплеск трафика с АРМ инженера АСУ ТП</h1>
<div class="box"><b>Сценарий.</b> В 02:40 SIEM зафиксировала рост исходящего трафика с АРМ инженера SCADA на внешний адрес. Дежурный сообщает…<div class="line w90"></div><div class="line w60"></div></div>
<div class="row" style="gap:6px;margin-bottom:6px"><span class="btn p">Журнал</span><span class="btn">Схема сети</span><span class="btn">Конфигурация МЭ</span><span class="btn">Заявка</span></div>
<div class="box" style="font-family:'Liberation Mono',monospace;font-size:11.5px;line-height:1.6;background:#f7f7f7">02:38:11 ALLOW 10.4.2.17:51022 → 185.x.x.x:443 bytes=48M<br>02:38:40 ALLOW 10.4.2.17:51023 → 185.x.x.x:443 bytes=51M<br>02:39:02 WARN  new service installed: "updsvc"<br>02:39:15 AUTH  eng_petrov logon type=10 src=10.4.9.3<br>…</div></div>
<div class="main" style="flex:1"><div class="row"><b style="flex:1">Шаг 2 из 4 · Приоритизация</b><span class="muted">⏱ 03:12</span></div>
<div class="row" style="gap:4px;margin:8px 0 14px"><div class="bar" style="flex:1"><i style="width:100%"></i></div><div class="bar" style="flex:1"><i style="width:50%"></i></div><div class="bar" style="flex:1"></div><div class="bar" style="flex:1"></div></div>
<div class="box"><b>Расставьте действия в порядке выполнения</b>${["Изолировать АРМ от сети (карантинный VLAN)","Сохранить журналы и снимок памяти","Заблокировать учётную запись eng_petrov","Уведомить ответственного за ИБ и ГосСОПКА","Проверить другие АРМ сегмента"].map((t,i)=>`<div class="box" style="margin:8px 0;padding:8px">☰ <b>${i+1}.</b> ${t}</div>`).join("")}</div>
<div class="row"><span class="btn">← Шаг 1</span><span class="sp" style="flex:1"></span><span class="btn p">Ответить →</span></div></div></div>
${note(1, 20, 400, "Материалы кейса: вкладки с журналом, схемой, конфигом")}${note(2, 1000, 100, "Шаги по одному; критический шаг с ошибкой ведёт к шагу-«последствию»")}${note(3, 700, 440, "Типы шагов: выбор, порядок, поиск ошибки, текст")}`,

"w4-dashboard": `${top(T_CAND, "Кабинет", "Сотрудник")}<div class="wrap">
<div class="side"><h4>Кабинет</h4><div class="si on">Дашборд</div><div class="si">Мои проверки</div><div class="si">Сертификаты и профили</div><div class="si">Рекомендации</div><div class="si">Профиль</div></div>
<div class="main"><h1>Добрый день, Мария</h1><div class="muted">06.032 · Специалист по безопасности компьютерных систем и сетей</div>
<div class="grid" style="grid-template-columns:repeat(4,1fr);margin:14px 0"><div class="box"><div class="muted">Итоговая оценка</div><div style="font-size:28px;font-weight:700">71 / 100</div>Сильный специалист</div><div class="box"><div class="muted">Решено задач</div><div style="font-size:28px;font-weight:700">18 / 40</div></div><div class="box"><div class="muted">Подтв. сертификаты</div><div style="font-size:28px;font-weight:700">2</div></div><div class="box"><div class="muted">Уровень</div><div style="font-size:28px;font-weight:700">Специалист</div></div></div>
<h2>Карта компетенций (тема × уровень)</h2><table class="heat"><tr><th>Тема</th><th>Базовый</th><th>Специалист</th><th>Эксперт</th></tr>
${[["Компьютерные сети",[90,70,30]],["Криптография и СКЗИ",[100,60,0]],["Инциденты",[80,75,40]],["SIEM и мониторинг",[60,30,0]],["Политики и орг. меры",[40,10,0]]].map(([t,v])=>`<tr><td style="text-align:left;font-weight:400">${t}</td>${v.map(x=>`<td style="background:rgba(0,0,0,${x/130});color:${x>55?"#fff":"#000"}">${x}%</td>`).join("")}</tr>`).join("")}</table></div>
<div class="rt"><b>Что изучить дальше</b>${["Политики и орг. меры — 1/4","SIEM — уровень Специалист","Криптография — Эксперт"].map(t=>`<div class="box" style="margin-top:8px">${t}<div class="line w60"></div><span class="btn" style="margin-top:6px;padding:4px 10px">Задачи →</span></div>`).join("")}</div></div>
${note(1, 380, 450, "Тепловая карта: где сильные и слабые места")}${note(2, 1010, 420, "Рекомендации ведут в Академию и к задачам")}`,

"w5-reviewer": `${top(T_REV, "Ревьюер", "Ревьюер")}<div class="wrap">
<div class="side" style="width:290px"><h4>Очередь на оценку · 7</h4>${[["Волков А. С.","06.032 · 57*","2 кейса"],["Смирнова О. В.","06.030 · 64","решение"],["Петров И. С.","06.032 · 22*","1 кейс"],["Кузнецова О.","06.053 · 78","сертификат"]].map(([n,s,w],i)=>`<div class="box" style="padding:9px;${i===0?"border-color:#000;border-width:2.5px":""}"><b>${n}</b><div class="muted">${s}</div><span class="chip">ждёт: ${w}</span></div>`).join("")}</div>
<div class="main"><div class="row"><div style="flex:1"><h1>Волков Андрей Сергеевич</h1><div class="muted">06.032 · кандидат · проверка №195</div></div><span class="btn">Сравнить</span><span class="btn">PDF</span></div>
<div class="box row" style="background:#f2f2f2"><div style="font-size:40px;font-weight:700">57</div><div><b>Уверенный базовый уровень</b><div class="muted">Предварительно: кейс оценён AI, не ревьюером</div></div></div>
${[["Знания (с учётом сложности)",30.4,45],["Темп",4.7,5],["Практика",21.5,35],["Сертификаты",0,15]].map(([t,p,m])=>`<div class="row" style="margin:6px 0"><span style="width:240px">${t}</span><div class="bar" style="flex:1"><i style="width:${p/m*100}%"></i></div><b style="width:70px;text-align:right">${p}/${m}</b></div>`).join("")}
<h2>AI-резюме</h2><div class="box"><b>Специалист уверенного базового уровня…</b><div class="line w90"></div><div class="line w80"></div><div class="row" style="align-items:flex-start"><div style="flex:1"><b>Сильные</b><div class="line w80"></div><div class="line w60"></div></div><div style="flex:1"><b>Слабые</b><div class="line w80"></div><div class="line w40"></div></div></div></div>
<h2>Кейс-задание к оценке</h2><div class="box"><b>Задача 29: аномальное поведение бизнес-приложения</b><div class="line w90"></div><div class="row"><span>Оценка:</span><span class="box" style="margin:0;padding:4px 14px">40</span><span class="box" style="margin:0;flex:1;padding:4px 10px">Комментарий…</span><span class="btn p">Сохранить</span></div></div></div></div>
${note(1, 40, 420, "Очередь: что ждёт действия ревьюера")}${note(2, 900, 170, "Итоговая оценка с разложением")}${note(3, 720, 600, "Оценка кейса по рубрике пересчитывает балл")}`,

"w6-analytics": `${top(T_AN, "Аналитика ОЦК", "Аналитик ОЦК")}<div class="wrap">
<div class="side"><h4>Срез</h4><div class="box"><b>Отрасль</b><div>Промышленность ▾</div></div><div class="box"><b>Организации</b><div>Все (12) ▾</div></div><div class="box"><b>Направление ОЦК</b><div>Все ▾</div></div><div class="box"><b>Период</b><div>2026, III кв. ▾</div></div><div class="box muted">🔒 Данные обезличены: ФИО и ответы недоступны</div></div>
<div class="main"><h1>Дефицит компетенций по организациям</h1><div class="muted">Доля специалистов ниже уровня «Специалист» · 412 проверок</div>
<table class="heat" style="margin-top:12px"><tr><th>Организация</th><th>Защита ПДн</th><th>Безопасность КИИ</th><th>Реагирование на атаки</th><th>Режим секретности</th><th>Тех. защита гостайны</th></tr>
${[["Завод №1",[20,45,30,10,15]],["Завод №2",[35,60,55,20,25]],["НПО «Альфа»",[15,25,20,5,10]],["Комбинат «Север»",[40,70,65,30,35]],["КБ «Вектор»",[10,20,15,5,5]]].map(([o,v])=>`<tr><td style="text-align:left;font-weight:400">${o}</td>${v.map(x=>`<td style="background:rgba(0,0,0,${x/110});color:${x>55?"#fff":"#000"}">${x}%</td>`).join("")}</tr>`).join("")}</table>
<div class="row" style="align-items:flex-start;margin-top:12px"><div class="box" style="flex:1"><b>Потребность в подготовке (п. 3.1.20)</b><table><tr><th>Направление</th><th>Нужно обучить</th><th>Срок</th></tr><tr><td>Безопасность КИИ</td><td>48 чел.</td><td>IV кв.</td></tr><tr><td>Реагирование на атаки</td><td>31 чел.</td><td>IV кв.</td></tr><tr><td>Защита ПДн</td><td>17 чел.</td><td>2027</td></tr></table></div><div class="box" style="flex:1"><b>Динамика по кварталам</b><div class="ph" style="height:120px;margin-top:8px"></div></div></div></div></div>
${note(1, 20, 440, "Только агрегаты — в отличие от ревьюера")}${note(2, 380, 490, "Строки — организации, столбцы — направления ОЦК")}${note(3, 760, 490, "План подготовки кадров — функция 3.1.19–3.1.20")}`,

"w7-methodist": `${top(T_MET, "Методист", "Методист")}<div class="wrap">
<div class="side"><h4>Банк задач</h4><div class="si">Все задачи (124)</div><div class="si on">Редактор</div><div class="si">Рубрики</div><div class="si">Статистика задач</div><div class="si">Привязка к ТФ</div></div>
<div class="main"><h1>Редактор ситуационной задачи</h1><div class="grid" style="grid-template-columns:1fr 1fr">
<div class="box"><b>Название</b><div class="box" style="margin:6px 0 0;padding:6px">Ночной всплеск трафика с АРМ инженера АСУ ТП</div></div>
<div class="box"><b>Компетенция (ТФ) · уровень</b><div class="row" style="margin-top:6px"><span class="box" style="margin:0;padding:6px;flex:1">06.032 · A/01.5 ▾</span><span class="lvl b">БАЗОВЫЙ</span></div></div></div>
<div class="box"><b>Сценарий и материалы</b><div class="line w90"></div><div class="line w80"></div><span class="chip">📄 журнал.log</span><span class="chip">🖼 схема.png</span><span class="chip">+ добавить</span></div>
<b>Шаги</b>${[["1","Выбор","Какие признаки значимы?","критический"],["1a","Последствие","Атака распространилась: что теперь?",""],["2","Порядок","Расставьте действия реагирования",""],["3","Поиск ошибки","Найдите ошибку в правиле МЭ",""],["4","Текст","Что включить в отчёт об инциденте?","оценивает ревьюер"]].map(([n,t,q,f])=>`<div class="box row" style="padding:8px"><b style="width:28px">${n}</b><span class="chip">${t}</span><span style="flex:1">${q}</span>${f?`<span class="st">${f}</span>`:""}<span>✎</span></div>`).join("")}</div>
<div class="rt"><b>Рубрика шага 4</b>${["Указаны время и признаки — 2","Перечислены действия — 3","Затронутые активы — 2","Меры предотвращения — 3"].map(t=>`<div class="box" style="margin-top:6px;padding:7px">${t}</div>`).join("")}<h2>Темы</h2><span class="chip">Инциденты</span><span class="chip">КИИ</span><span class="chip">SIEM</span><div style="margin-top:12px"><span class="btn p">Опубликовать</span></div></div></div>
${note(1, 380, 580, "Шаг-последствие подключается при ошибке на критическом шаге")}${note(2, 1000, 380, "Рубрика: критерии и баллы для текстовых шагов")}`,
};

const H = {"w1-academy":600,"w2-catalog":480,"w3-task":500,"w4-dashboard":520,"w5-reviewer":650,"w6-analytics":560,"w7-methodist":640};
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  for (const [name, body] of Object.entries(pages)) {
    await p.setViewportSize({ width: 1280, height: H[name] });
    await p.setContent(`<html><head><style>${CSS} html,body{height:${H[name]}px;position:relative;overflow:hidden}</style></head><body>${body}</body></html>`);
    await p.screenshot({ path: `wireframes/${name}.png` });
    console.log("ok", name);
  }
  await b.close();
})();
