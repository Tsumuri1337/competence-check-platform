-- Схема БД: платформа проверки компетенций на основе профстандартов Минтруда.
-- Заменяет прежнюю схему HR background-check PoC целиком.

-- Справочные данные, транскрибированные из официальных профстандартов
-- (см. backend/src/content/*.json — источник для seed.js).

CREATE TABLE IF NOT EXISTS standards (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,           -- '06.030' и т.д.
  title TEXT NOT NULL,
  order_ref TEXT NOT NULL,             -- 'Приказ Минтруда России от 14.09.2022 N 536н'
  source_url TEXT
);

CREATE TABLE IF NOT EXISTS generalized_functions (
  id SERIAL PRIMARY KEY,
  standard_id INTEGER NOT NULL REFERENCES standards(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                  -- 'A', 'B', ...
  title TEXT NOT NULL,
  qualification_level INTEGER NOT NULL,
  UNIQUE (standard_id, code)
);

CREATE TABLE IF NOT EXISTS labor_functions (
  id SERIAL PRIMARY KEY,
  generalized_function_id INTEGER NOT NULL REFERENCES generalized_functions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,                  -- 'A/01.5', ...
  title TEXT NOT NULL,
  UNIQUE (generalized_function_id, code)
);

CREATE TABLE IF NOT EXISTS competency_items (
  id SERIAL PRIMARY KEY,
  labor_function_id INTEGER NOT NULL REFERENCES labor_functions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('knowledge', 'skill')),
  text TEXT NOT NULL
);

-- Авторский тестовый контент (не из профстандарта напрямую — вопросы и
-- задания составлены нами на основе транскрибированных знаний/умений).

CREATE TABLE IF NOT EXISTS quiz_questions (
  id SERIAL PRIMARY KEY,
  standard_id INTEGER NOT NULL REFERENCES standards(id) ON DELETE CASCADE,
  labor_function_id INTEGER REFERENCES labor_functions(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  options JSONB NOT NULL,              -- ["вариант 1", "вариант 2", ...]
  correct_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS practical_tasks (
  id SERIAL PRIMARY KEY,
  standard_id INTEGER NOT NULL REFERENCES standards(id) ON DELETE CASCADE,
  labor_function_id INTEGER REFERENCES labor_functions(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  rubric TEXT NOT NULL
);

-- Люди и организации.

CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  context TEXT NOT NULL CHECK (context IN ('employee', 'candidate')),
  organization_id INTEGER REFERENCES organizations(id)
);

-- full_name и email хранятся зашифрованными (AES-256-GCM, см. src/lib/pii.js).
-- Шифртекст со случайным IV не годится для поиска и UNIQUE, поэтому
-- уникальность и поиск по email идут через детерминированный HMAC-хэш.
ALTER TABLE people ADD COLUMN IF NOT EXISTS email_hash TEXT;
ALTER TABLE people DROP CONSTRAINT IF EXISTS people_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS people_email_hash_key ON people(email_hash);

CREATE TABLE IF NOT EXISTS reviewers (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'reviewer'
);

-- Пароль хранится как scrypt-хэш ("соль:хэш" в hex, см. src/lib/auth.js) —
-- заменяет прежнюю PoC-заглушку через заголовок X-Reviewer-Email.
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Неудачные попытки входа — для блокировки перебора пароля (см. routes/auth.js).
-- key: 'email:<нормализованный email>' или 'ip:<адрес>'; храним в БД, а не в
-- памяти процесса, чтобы лимит переживал перезапуск и работал на нескольких инстансах.
CREATE TABLE IF NOT EXISTS login_attempts (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_key_at ON login_attempts(key, at);

CREATE TABLE IF NOT EXISTS reviewer_sessions (
  id SERIAL PRIMARY KEY,
  reviewer_id INTEGER NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,   -- sha256 токена из httpOnly-куки; сам токен на сервере не хранится
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Прохождение проверки: анкета -> квиз -> практическое задание -> самооценка.

CREATE TABLE IF NOT EXISTS assessments (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  standard_id INTEGER NOT NULL REFERENCES standards(id),
  context TEXT NOT NULL CHECK (context IN ('employee', 'candidate')),
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Решение по кандидату (найм/отказ) — задел только для context='candidate';
-- для сотрудников пока не используется (см. backend/README.md).
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS decision TEXT CHECK (decision IN ('accepted', 'rejected', 'pending'));

-- Случайная выборка вопросов теста и практических заданий для этой
-- конкретной проверки — выбирается один раз (при первом запросе) и
-- сохраняется здесь, чтобы обновление страницы или восстановление
-- прогресса показывало тот же набор в том же порядке, а не новую выборку.
-- quiz_assignment: [{ "questionId": 1, "optionOrder": [2,0,3,1] }, ...] —
-- optionOrder переставляет варианты ответа для показа; переводится обратно
-- в исходный индекс при сохранении ответа (см. routes/assessments.js).
-- task_assignment: [taskId, taskId] — просто порядок показа.
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS quiz_assignment JSONB;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS task_assignment JSONB;

CREATE TABLE IF NOT EXISTS quiz_responses (
  id SERIAL PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id),
  selected_index INTEGER NOT NULL,
  is_correct BOOLEAN NOT NULL,
  UNIQUE (assessment_id, question_id)
);

CREATE TABLE IF NOT EXISTS practical_submissions (
  id SERIAL PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES practical_tasks(id),
  submission_text TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewer_id INTEGER REFERENCES reviewers(id),
  reviewer_score INTEGER,
  reviewer_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  UNIQUE (assessment_id, task_id)
);

CREATE TABLE IF NOT EXISTS self_assessment_ratings (
  id SERIAL PRIMARY KEY,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  competency_item_id INTEGER NOT NULL REFERENCES competency_items(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  UNIQUE (assessment_id, competency_item_id)
);

CREATE TABLE IF NOT EXISTS access_log (
  id SERIAL PRIMARY KEY,
  reviewer_id INTEGER NOT NULL REFERENCES reviewers(id),
  assessment_id INTEGER NOT NULL REFERENCES assessments(id),
  action TEXT NOT NULL,   -- 'view_report' | 'score_submission'
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
