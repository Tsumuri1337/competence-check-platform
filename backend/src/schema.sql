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
  email TEXT NOT NULL UNIQUE,
  context TEXT NOT NULL CHECK (context IN ('employee', 'candidate')),
  organization_id INTEGER REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS reviewers (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'reviewer'
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
