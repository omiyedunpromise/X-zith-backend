-- ============================================================
-- X-ZITH Learning Hub — Database Setup
-- Run this ONCE on your Postgres database
-- ============================================================

-- ---------- 1. Generic AI output cache ----------
-- Stores every reusable AI response (textbook, past questions,
-- theory, explanations, search, daily challenge, quiz arena)
CREATE TABLE IF NOT EXISTS ai_cache (
    cache_key   TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    content     JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    hit_count   INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_category   ON ai_cache (category);
CREATE INDEX IF NOT EXISTS idx_ai_cache_created_at ON ai_cache (created_at DESC);

-- ---------- 2. Permanent theory questions ----------
-- Once generated for an exam + subject, stays forever
CREATE TABLE IF NOT EXISTS theory_questions (
    exam        TEXT NOT NULL,
    subject     TEXT NOT NULL,
    questions   TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (exam, subject)
);

CREATE INDEX IF NOT EXISTS idx_theory_exam_subject ON theory_questions (exam, subject);

-- ---------- 3. Chat history (per user) ----------
-- Every message sent/received is saved so it survives reload + deploy
CREATE TABLE IF NOT EXISTS chat_history (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('user', 'ai')),
    content     TEXT NOT NULL,
    has_image   BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_user_time ON chat_history (user_id, created_at ASC);

-- ============================================================
-- OPTIONAL — handy queries for you to run later
-- ============================================================

-- See how many items cached per feature:
-- SELECT category, COUNT(*) AS count FROM ai_cache GROUP BY category ORDER BY count DESC;

-- See the 10 most reused responses:
-- SELECT category, cache_key, hit_count FROM ai_cache ORDER BY hit_count DESC LIMIT 10;

-- See theory questions stored:
-- SELECT exam, subject, created_at FROM theory_questions ORDER BY created_at DESC;

-- See the last 20 messages from user #1:
-- SELECT role, LEFT(content, 60) AS preview, created_at
-- FROM chat_history WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20;

-- Clear one cache category:
-- DELETE FROM ai_cache WHERE category = 'textbook';

-- Clear one user's chat:
-- DELETE FROM chat_history WHERE user_id = 1;

-- Nuke everything cached (fresh start):
-- DELETE FROM ai_cache;
-- DELETE FROM theory_questions;
-- DELETE FROM chat_history;