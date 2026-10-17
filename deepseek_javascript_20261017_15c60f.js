/* ============================================================
   X-ZITH Learning Hub — Backend
   Gemini (2.5-flash-lite) primary + Groq (llama-3.3-70b) fallback
   Persistent DB cache  •  Cross-device user data  •  Chat history
   ============================================================ */

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '12mb' }));

// ============================================================
// CORS
// ============================================================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ============================================================
// CONFIG
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ============================================================
// AI TUTOR IDENTITY
// ============================================================
const AI_TUTOR_IDENTITY = `You are "AI Tutor", the study assistant inside the X-ZITH Learning Hub app, built for Nigerian secondary school students preparing for WAEC, NECO and JAMB.

About you:
- Your name is "AI Tutor".
- You were created by X-ZITH Technology.
- If anyone asks "who created you" or "who made you", respond exactly: "I am created by X-ZITH Technology."
- If anyone asks "who is the CEO / founder of X-ZITH Technology?", respond exactly: "Promise Omiyedun is the CEO and founder of X-ZITH Technology."
- Never mention Google, Gemini, Groq, Meta, OpenAI, or any other AI company. You are AI Tutor from X-ZITH Technology.

Style:
- Answer clearly, using markdown formatting.
- Be warm, encouraging, and exam-focused.
- If the student uploads a photo of a question, read it carefully and solve it step by step.

FORMATTING RULES:
- Use markdown tables when comparing things.
- Use ASCII diagrams inside fenced code blocks for processes and structures.
- For calculations, write each step on its own line, aligned equals signs, like a teacher on a board.`;

// ============================================================
// DB CACHE
// ============================================================
async function dbCacheGet(category, key) {
    try {
        const fullKey = category + '|' + key;
        const result = await pool.query('SELECT content FROM ai_cache WHERE cache_key = $1', [fullKey]);
        if (result.rows.length > 0) {
            pool.query('UPDATE ai_cache SET hit_count = hit_count + 1 WHERE cache_key = $1', [fullKey]).catch(() => {});
            return result.rows[0].content;
        }
        return null;
    } catch (err) { return null; }
}
async function dbCacheSet(category, key, content) {
    try {
        const fullKey = category + '|' + key;
        await pool.query(
            `INSERT INTO ai_cache (cache_key, category, content)
             VALUES ($1, $2, $3)
             ON CONFLICT (cache_key) DO UPDATE
             SET content = EXCLUDED.content, created_at = NOW()`,
            [fullKey, category, JSON.stringify(content)]
        );
    } catch (err) { console.error('Cache write error:', err.message); }
}
async function dbCacheStats() {
    try {
        const result = await pool.query('SELECT category, COUNT(*)::int AS count FROM ai_cache GROUP BY category');
        const stats = {};
        result.rows.forEach(r => { stats[r.category] = r.count; });
        return stats;
    } catch (err) { return {}; }
}
async function dbCacheClear(category) {
    try {
        if (category) await pool.query('DELETE FROM ai_cache WHERE category = $1', [category]);
        else await pool.query('DELETE FROM ai_cache');
        return true;
    } catch (err) { return false; }
}

// ============================================================
// HELPERS
// ============================================================
function sha1(str) { return crypto.createHash('sha1').update(String(str)).digest('hex'); }
function todayKey() {
    const now = new Date(Date.now() + 60 * 60 * 1000);
    return now.toISOString().slice(0, 10);
}

// ============================================================
// VALIDATOR
// ============================================================
function validateAI(text, options = {}) {
    const minLength = options.minLength || 40;
    const minWords = options.minWords || 8;
    const requireMarkers = options.requireMarkers || null;
    if (!text || typeof text !== 'string') return { ok: false, reason: 'empty' };
    const t = text.trim();
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t)) return { ok: false, reason: 'pure-number' };
    if (/^(nan|null|undefined|n\/a|error|unknown|none)$/i.test(t)) return { ok: false, reason: 'placeholder' };
    if (t.length < minLength) return { ok: false, reason: 'too-short' };
    if (t.split(/\s+/).length < minWords) return { ok: false, reason: 'too-few-words' };
    if (/^(.)\1{10,}$/.test(t)) return { ok: false, reason: 'repeated-char' };
    if (Array.isArray(requireMarkers)) {
        const anyMatch = requireMarkers.some(re => re.test(t));
        if (!anyMatch) return { ok: false, reason: 'missing-required-structure' };
    }
    return { ok: true };
}

// ============================================================
// AI PROVIDERS
// ============================================================
async function callGemini(prompt, timeout = 60000) {
    if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty response');
    return text;
}
async function callGeminiVision(prompt, imageDataUrl, timeout = 90000) {
    if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
    const m = String(imageDataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid image format');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: m[1], data: m[2] } }] }]
    }, { timeout });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini vision returned empty response');
    return text;
}
async function callGroq(prompt, timeout = 60000) {
    if (!groq) throw new Error('Groq API key not configured');
    const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
    }, { timeout });
    const text = completion?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Groq returned empty response');
    return text;
}
async function callAI(primary, prompt, timeout) {
    const order = primary === 'gemini' ? ['gemini', 'groq'] : ['groq', 'gemini'];
    let lastError = null;
    for (const provider of order) {
        try {
            if (provider === 'gemini') return await callGemini(prompt, timeout);
            return await callGroq(prompt, timeout);
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ ${provider} failed (${err.message}). Trying next...`);
        }
    }
    throw lastError || new Error('All AI providers failed');
}
async function callAIValidated(primary, prompt, timeout, validateOpts) {
    const attempts = [primary, primary === 'gemini' ? 'groq' : 'gemini', primary, primary === 'gemini' ? 'groq' : 'gemini'];
    let lastReason = null;
    for (let i = 0; i < attempts.length; i++) {
        try {
            const text = await callAI(attempts[i], prompt, timeout);
            const check = validateAI(text, validateOpts);
            if (check.ok) return text;
            lastReason = check.reason;
        } catch (err) { lastReason = err.message; }
    }
    const e = new Error('AI could not produce a valid response. Please try again.');
    e.reason = lastReason || 'all-attempts-failed';
    throw e;
}

const PROMPT_FOOTER = `

FORMATTING RULES:
- Respond with human-readable sentences and paragraphs only.
- Never respond with a single number, formula, or code.
- Use markdown tables when comparing things.
- Use a simple ASCII diagram inside a fenced code block for processes and structures.
- For calculations, write each step on its own line, aligned equals signs, like a teacher on a board.
- If you cannot produce useful educational content, respond exactly: "I could not generate this content."`;

// ============================================================
// HEALTH
// ============================================================
app.get('/', async (req, res) => {
    const stats = await dbCacheStats();
    res.json({
        message: '✅ X-ZITH Backend is RUNNING!',
        status: 'ok',
        creator: {
            name: 'Promise Omiyedun',
            title: 'CEO and Founder of X-ZITH Technology',
            platform: 'X-ZITH Learning Hub'
        },
        ai: {
            gemini: !!GEMINI_API_KEY, geminiModel: GEMINI_MODEL,
            groq: !!GROQ_API_KEY, groqModel: GROQ_MODEL,
            serpapi: !!SERPAPI_KEY
        },
        cache: stats,
        timestamp: new Date()
    });
});

app.get('/api/cache-stats', async (req, res) => {
    const stats = await dbCacheStats();
    res.json({ success: true, cache: stats });
});

app.post('/api/clear-cache', async (req, res) => {
    const { secret, category } = req.body || {};
    if (secret !== (process.env.CACHE_SECRET || 'xzith-reset-2026')) return res.status(403).json({ error: 'Forbidden' });
    const ok = await dbCacheClear(category);
    if (ok) res.json({ success: true, cleared: category || 'all' });
    else res.status(500).json({ error: 'Failed to clear cache' });
});

app.get('/api/about', (req, res) => {
    res.json({
        success: true,
        app: {
            name: 'X-ZITH Learning Hub',
            tagline: 'AI-Powered Education Platform for Nigerian Students',
            createdBy: {
                name: 'Promise Omiyedun',
                title: 'CEO and Founder of X-ZITH Technology',
                role: 'Creator of X-ZITH Learning Hub'
            },
            poweredBy: 'X-ZITH Technology',
            copyright: `© ${new Date().getFullYear()} X-ZITH Learning Hub. All rights reserved.`
        }
    });
});

// ============================================================
// AUTH
// ============================================================
function hashPassword(password) { return crypto.createHash('sha256').update(password).digest('hex'); }

app.post('/api/signup', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ success: false, error: 'All fields required' });
        if (password.length < 6) return res.status(400).json({ success: false, error: 'Password must be 6+ characters' });
        const passwordHash = hashPassword(password);
        const today = new Date().toISOString().split('T')[0];
        const result = await pool.query(
            `INSERT INTO users (username, email, password_hash, total_score, quizzes_taken, exam_questions, streak, created_at)
             VALUES ($1, $2, $3, 0, 0, 0, 1, $4)
             RETURNING id, username, email, total_score, quizzes_taken, exam_questions, streak`,
            [username, email, passwordHash, today]
        );
        if (result.rows.length > 0) res.json({ success: true, message: 'Account created! Please login.', user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') res.status(400).json({ success: false, error: 'Username or email already exists' });
        else res.status(500).json({ error: 'Signup failed: ' + err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
        const passwordHash = hashPassword(password);
        const result = await pool.query('SELECT * FROM users WHERE email = $1 AND password_hash = $2', [email, passwordHash]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            res.json({
                success: true,
                message: 'Login successful',
                user: {
                    id: user.id, username: user.username, email: user.email,
                    total_score: user.total_score, quizzes_taken: user.quizzes_taken,
                    exam_questions: user.exam_questions, streak: user.streak
                }
            });
        } else res.status(401).json({ success: false, error: 'Invalid email or password' });
    } catch (err) {
        res.status(500).json({ error: 'Login failed: ' + err.message });
    }
});

// ============================================================
// USER ACTIVITY (Recent Quizzes)
// ============================================================
app.post('/api/user/activity', async (req, res) => {
    try {
        const { userId, topic, subject, score, total, kind } = req.body || {};
        if (!userId || !topic) return res.status(400).json({ error: 'userId and topic are required' });
        await pool.query(
            `INSERT INTO user_activity (user_id, topic, subject, score, total, kind)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, topic, subject || null, parseInt(score) || 0, parseInt(total) || 0, kind || 'quiz']
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save activity' });
    }
});

app.get('/api/user/activity/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(
            `SELECT id, topic, subject, score, total, kind, created_at
             FROM user_activity WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 20`,
            [userId]
        );
        res.json({ success: true, activity: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load activity' });
    }
});

// ============================================================
// USER STUDY (Recent Study)
// ============================================================
app.post('/api/user/study', async (req, res) => {
    try {
        const { userId, type, title, subject, level } = req.body || {};
        if (!userId || !title) return res.status(400).json({ error: 'userId and title are required' });
        await pool.query(
            `INSERT INTO user_study (user_id, type, title, subject, level)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, type || 'textbook', title, subject || null, level || null]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save study' });
    }
});

app.get('/api/user/study/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(
            `SELECT id, type, title, subject, level, created_at
             FROM user_study WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 20`,
            [userId]
        );
        res.json({ success: true, study: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load study' });
    }
});

// ============================================================
// DAILY GOAL
// ============================================================
app.post('/api/user/daily-goal/bump', async (req, res) => {
    try {
        const { userId } = req.body || {};
        if (!userId) return res.status(400).json({ error: 'userId required' });
        const dateKey = todayKey();
        await pool.query(
            `INSERT INTO user_goals (user_id, date_key, quizzes)
             VALUES ($1, $2, 1)
             ON CONFLICT (user_id, date_key)
             DO UPDATE SET quizzes = user_goals.quizzes + 1`,
            [userId, dateKey]
        );
        const r = await pool.query(
            'SELECT quizzes FROM user_goals WHERE user_id = $1 AND date_key = $2',
            [userId, dateKey]
        );
        res.json({ success: true, quizzes: r.rows[0]?.quizzes || 0, date: dateKey });
    } catch (err) {
        res.status(500).json({ error: 'Failed to bump daily goal' });
    }
});

app.get('/api/user/daily-goal/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const dateKey = todayKey();
        const r = await pool.query(
            'SELECT quizzes FROM user_goals WHERE user_id = $1 AND date_key = $2',
            [userId, dateKey]
        );
        res.json({ success: true, quizzes: r.rows[0]?.quizzes || 0, date: dateKey });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load daily goal' });
    }
});

// ============================================================
// CHAT HISTORY
// ============================================================
app.get('/api/chat-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(
            `SELECT id, role, content, has_image, created_at
             FROM chat_history WHERE user_id = $1
             ORDER BY created_at ASC LIMIT 200`,
            [userId]
        );
        res.json({ success: true, messages: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load chat history' });
    }
});

app.delete('/api/chat-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        await pool.query('DELETE FROM chat_history WHERE user_id = $1', [userId]);
        res.json({ success: true, cleared: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear chat' });
    }
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message, image, userId } = req.body;

        const hasImage = image && typeof image === 'string' && image.startsWith('data:image/');
        if ((!message || typeof message !== 'string') && !hasImage) {
            return res.status(400).json({ error: 'Message or image is required' });
        }
        const safeMessage = (typeof message === 'string' ? message : '').trim()
            || 'Please describe and answer what is in this image.';

        if (userId) {
            try {
                await pool.query(
                    `INSERT INTO chat_history (user_id, role, content, has_image)
                     VALUES ($1, 'user', $2, $3)`,
                    [userId, safeMessage, !!image]
                );
            } catch (e) { console.error('Save user msg error:', e.message); }
        }

        let reply = null;

        if (hasImage) {
            try {
                const visionPrompt = `${AI_TUTOR_IDENTITY}

The student uploaded an image. Read it carefully and solve or explain step by step.

Student's message: ${safeMessage}`;
                reply = await callGeminiVision(visionPrompt, image, 90000);
            } catch (err) {
                console.warn('Vision failed, falling back to text-only:', err.message);
            }
        }

        if (!reply) {
            const prompt = `${AI_TUTOR_IDENTITY}

Question from student: ${safeMessage}`;
            reply = await callAI('gemini', prompt, 60000);
        }

        if (userId && reply) {
            try {
                await pool.query(
                    `INSERT INTO chat_history (user_id, role, content, has_image)
                     VALUES ($1, 'ai', $2, false)`,
                    [userId, reply]
                );
            } catch (e) { console.error('Save ai msg error:', e.message); }
        }

        res.json({ success: true, response: reply });
    } catch (err) {
        res.status(500).json({ error: 'Chat failed: ' + err.message });
    }
});

// ============================================================
// PUSH THEORY / DAILY
// ============================================================
app.post('/api/push-theory', async (req, res) => {
    try {
        const { secret, theory } = req.body || {};
        const PUSH_SECRET = process.env.PUSH_SECRET || 'xzith-push-2026';
        if (secret !== PUSH_SECRET) return res.status(403).json({ error: 'Forbidden' });
        if (!theory || typeof theory !== 'object') return res.status(400).json({ error: 'Missing theory object' });

        let total = 0;
        for (const exam of Object.keys(theory)) {
            for (const subject of Object.keys(theory[exam])) {
                const questions = theory[exam][subject];
                if (!Array.isArray(questions) || !questions.length) continue;
                await pool.query(
                    `INSERT INTO theory_questions (exam, subject, questions)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (exam, subject) DO UPDATE
                     SET questions = EXCLUDED.questions, created_at = NOW()`,
                    [exam, subject, JSON.stringify(questions)]
                );
                total += questions.length;
            }
        }
        res.json({ success: true, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/push-daily', async (req, res) => {
    try {
        const { secret, daily } = req.body || {};
        const PUSH_SECRET = process.env.PUSH_SECRET || 'xzith-push-2026';
        if (secret !== PUSH_SECRET) return res.status(403).json({ error: 'Forbidden' });
        if (!daily || typeof daily !== 'object') return res.status(400).json({ error: 'Missing daily object' });

        let total = 0;
        for (const subject of Object.keys(daily)) {
            const questions = daily[subject];
            if (!Array.isArray(questions) || !questions.length) continue;
            await pool.query(
                `INSERT INTO daily_questions (exam, questions)
                 VALUES ($1, $2)
                 ON CONFLICT (exam) DO UPDATE
                 SET questions = EXCLUDED.questions, created_at = NOW()`,
                [subject, JSON.stringify(questions)]
            );
            total += questions.length;
        }
        res.json({ success: true, total });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// TEXTBOOK — New structure (no Key Points, no Common Mistakes)
// ============================================================
app.post('/api/generate-textbook', async (req, res) => {
    try {
        const { level, subject, topic } = req.body;
        if (!level || !subject || !topic) return res.status(400).json({ error: 'level, subject and topic are required' });
        if (String(topic).trim().length < 3) return res.status(400).json({ error: 'Topic is too short.' });

        const key = `${level}|${subject}|${topic}`.toLowerCase();
        const cached = await dbCacheGet('textbook', key);
        if (cached) return res.json({ success: true, note: cached, cached: true });

        const prompt = `You are an experienced Nigerian secondary school teacher writing a comprehensive chapter for a ${level} student.

Subject: ${subject}
Topic: ${topic}

You MUST produce a full, detailed chapter (at least 500 words). Follow this structure EXACTLY and ONLY this structure:

## Introduction
A full paragraph explaining what ${topic} is and why it matters in ${subject}.

## Definition
A clear formal definition with an example.

## Types / Kinds
List and explain every main type or kind of ${topic}. Use a markdown table when comparing them.

## Rules and Usage
Explain the rules or principles governing ${topic} with at least 3 example sentences.

## Worked Examples
Provide 2 full worked examples with step-by-step explanations.
- For calculations, write each step on its own line, keeping the equals sign aligned the way a teacher writes on the board.
- Never skip steps.

## Diagrams / Illustrations
If ${topic} involves a structure, process, cycle, or relationship, include a simple ASCII diagram inside a fenced code block. If not applicable, skip this section.

## Practice Questions
3 practice questions with their answers.

Do NOT include a "Key Points to Remember" section.
Do NOT include a "Common Exam Mistakes" section.
${PROMPT_FOOTER}

Return the chapter in markdown.`;

        const note = await callAIValidated('gemini', prompt, 90000, { minLength: 150, minWords: 30 });
        await dbCacheSet('textbook', key, note);
        res.json({ success: true, note, cached: false });
    } catch (err) {
        res.status(502).json({ error: 'AI could not generate usable notes. Please try again.', reason: err.reason });
    }
});

// ============================================================
// PAST QUESTIONS — 30 questions, split into 3 levels of 10
// ============================================================
app.post('/api/generate-past-questions', async (req, res) => {
    try {
        const { exam, subject, qtype, topic } = req.body;
        if (!exam || !subject) return res.status(400).json({ error: 'exam and subject are required' });

        const key = `30|${exam}|${subject}|${topic || ''}`.toLowerCase();
        const cached = await dbCacheGet('pastQuestions30', key);
        if (cached) {
            console.log('📦 Past questions 30 cache HIT:', key);
            return res.json({ success: true, ...cached, cached: true });
        }

        const topicLine = topic ? `Focus on the topic: "${topic}".` : '';
        const prompt = `You are a ${exam} examiner in Nigeria.

Generate exactly 30 ${qtype || 'Objective'} questions for ${subject}. ${topicLine}

You MUST organize them into 3 levels:
- 10 EASY questions (Level 1)
- 10 MEDIUM questions (Level 2)
- 10 HARD questions (Level 3)

Use EXACTLY this format, with the level headers exactly as shown:

## LEVEL 1 (EASY)
1. Full question text?
A) option one
B) option two
C) option three
D) option four
Answer: A
Explanation: One-sentence reason.

2. Next question...
A) ...
B) ...
C) ...
D) ...
Answer: ...
Explanation: ...

(continue for 10 questions)

## LEVEL 2 (MEDIUM)
11. Full question text?
A) ...
B) ...
C) ...
D) ...
Answer: ...
Explanation: ...

(continue for 10 questions, numbered 11 to 20)

## LEVEL 3 (HARD)
21. Full question text?
A) ...
B) ...
C) ...
D) ...
Answer: ...
Explanation: ...

(continue for 10 questions, numbered 21 to 30)

Only output the questions in this exact format. No intro, no outro.`;

        const raw = await callAIValidated('groq', prompt, 150000, {
            minLength: 500, minWords: 100,
            requireMarkers: [/\bA\)/, /\bAnswer\s*[:\-]/i, /LEVEL\s*1/i, /LEVEL\s*2/i, /LEVEL\s*3/i]
        });

        // Split into 3 levels
        const level1Match = raw.split(/##\s*LEVEL\s*1/i)[1] || '';
        const level2Match = level1Match.split(/##\s*LEVEL\s*2/i);
        const level3Match = (level2Match[1] || '').split(/##\s*LEVEL\s*3/i);

        const level1 = (level2Match[0] || '').trim();
        const level2 = (level3Match[0] || '').trim();
        const level3 = (level3Match[1] || '').trim();

        const payload = {
            success: true,
            exam,
            subject,
            topic: topic || '',
            level1: level1 || raw,
            level2: level2 || '',
            level3: level3 || '',
            full: raw
        };

        // Only cache if all 3 levels have content
        if (level1 && level2 && level3) {
            await dbCacheSet('pastQuestions30', key, {
                exam, subject, topic: topic || '',
                level1, level2, level3, full: raw
            });
            console.log('💾 Past questions 30 saved:', key);
            res.json({ ...payload, cached: false });
        } else {
            // Fallback: return the raw text as level1 only
            console.warn('⚠️ Could not split into 3 levels cleanly. Returning full text.');
            res.json({ ...payload, level2: '', level3: '', cached: false });
        }
    } catch (err) {
        console.error('Past questions error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate usable questions. Please try again.', reason: err.reason });
    }
});

// ============================================================
// QUIZ (new page)
// ============================================================
app.post('/api/generate-quiz', async (req, res) => {
    try {
        const { subject, level, topic, count } = req.body;
        if (!subject) return res.status(400).json({ error: 'subject is required' });

        const n = Math.min(parseInt(count) || 5, 10);
        const lvl = level || 'SSS';
        const t = (topic || '').trim();
        const key = `quiz|${lvl}|${subject}|${t}|${n}`.toLowerCase();
        const cached = await dbCacheGet('quizzes', key);
        if (cached) return res.json({ success: true, raw: cached, cached: true });

        const topicLine = t ? `Focus on the topic: "${t}".` : 'Cover general questions.';
        const prompt = `You are a Nigerian exam question setter for ${lvl} level.

Generate exactly ${n} multiple-choice questions for: ${subject}
${topicLine}

Format EXACTLY:

1. Full question text?
A) option one
B) option two
C) option three
D) option four
Answer: A
Explanation: One-sentence reason.

(continue for all ${n})

Only output the questions.`;

        const raw = await callAIValidated('groq', prompt, 90000, {
            minLength: 100, minWords: 20,
            requireMarkers: [/\bA\)/, /\bAnswer\s*[:\-]/i]
        });

        await dbCacheSet('quizzes', key, raw);
        res.json({ success: true, raw, cached: false });
    } catch (err) {
        res.status(502).json({ error: 'AI could not generate a quiz. Please try again.', reason: err.reason });
    }
});

// ============================================================
// THEORY QUESTIONS (from DB)
// ============================================================
app.post('/api/generate-theory-question', async (req, res) => {
    try {
        const { exam, subject } = req.body;
        if (!exam || !subject) return res.status(400).json({ error: 'exam and subject are required' });

        const result = await pool.query(
            'SELECT questions, created_at FROM theory_questions WHERE exam = $1 AND subject = $2',
            [exam, subject]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({
                error: `No theory questions found for ${exam} ${subject}. Please push them from Colab.`
            });
        }
        const raw = result.rows[0].questions;
        const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
        res.json({ success: true, questions: parsed, source: 'db', stored_at: result.rows[0].created_at });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load theory questions: ' + err.message });
    }
});

// ============================================================
// THEORY EXPLANATION (5-section format)
// ============================================================
app.post('/api/explain-theory-question', async (req, res) => {
    try {
        const { exam, subject, question } = req.body;
        if (!question) return res.status(400).json({ error: 'question is required' });

        const key = `${exam}|${subject}|${sha1(question)}`.toLowerCase();
        const cached = await dbCacheGet('theoryExplain', key);
        if (cached) return res.json({ success: true, explanation: cached, cached: true });

        const prompt = `${AI_TUTOR_IDENTITY}

Provide a complete model answer for this ${exam} ${subject} theory question:

QUESTION:
${question}

Return your answer in EXACTLY these five sections, using these EXACT headings:

## STEPWISE GUIDE
Step-by-step walkthrough. Explain what the examiner is asking. Numbered steps.

## PERFECT ANSWER BLUEPRINT
Complete model answer as a top student would write it.

## MARKS MASTERY POINTS
Bulleted list of mark-scoring points. Include tables/diagrams if useful.

## MISTAKE DETECTOR
Common mistakes and how to avoid them.

## QUICK RECALL BOOSTER
A memory aid — mnemonic, acronym, or simple pattern.
${PROMPT_FOOTER}`;

        const explanation = await callAIValidated('gemini', prompt, 120000, { minLength: 200, minWords: 40 });
        await dbCacheSet('theoryExplain', key, explanation);
        res.json({ success: true, explanation, cached: false });
    } catch (err) {
        res.status(502).json({ error: 'AI could not generate a usable explanation. Please try again.', reason: err.reason });
    }
});

// ============================================================
// DAILY CHALLENGE
// ============================================================
app.get('/api/daily-challenge', async (req, res) => {
    try {
        const rows = await pool.query('SELECT exam, questions FROM daily_questions');
        if (rows.rows.length === 0) return res.status(404).json({ error: 'No daily questions pushed yet.' });

        const groups = [];
        rows.rows.forEach(r => {
            const qs = Array.isArray(r.questions) ? r.questions : JSON.parse(r.questions);
            groups.push({ subject: r.exam, questions: qs });
        });

        const dateStr = todayKey();
        const dayNumber = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / (1000 * 60 * 60 * 24));
        const groupIndex = dayNumber % groups.length;
        const group = groups[groupIndex];
        const questionIndex = Math.floor(dayNumber / groups.length) % group.questions.length;
        const today = group.questions[questionIndex];

        res.json({ success: true, challenge: { ...today, subject: group.subject, date: dateStr } });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load daily challenge: ' + err.message });
    }
});

// ============================================================
// WEB SEARCH
// ============================================================
app.post('/api/search', async (req, res) => {
    try {
        const { q } = req.body;
        if (!q || typeof q !== 'string') return res.status(400).json({ error: 'Query required' });
        if (!SERPAPI_KEY) return res.status(500).json({ error: 'SerpAPI key not configured' });

        const key = q.trim().toLowerCase();
        const cached = await dbCacheGet('webSearch', key);
        if (cached) return res.json({ success: true, results: cached, cached: true });

        const response = await axios.get('https://serpapi.com/search', {
            params: { q, api_key: SERPAPI_KEY, engine: 'google', num: 5 },
            timeout: 30000
        });

        const results = response.data.organic_results?.slice(0, 5) || [];
        const formatted = results.map(r => ({ title: r.title, snippet: r.snippet, link: r.link }));
        if (!formatted.length) return res.status(502).json({ error: 'No search results.' });

        await dbCacheSet('webSearch', key, formatted);
        res.json({ success: true, results: formatted, cached: false });
    } catch (err) {
        res.status(500).json({ error: 'Search failed: ' + err.message });
    }
});

// ============================================================
// LEADERBOARD
// ============================================================
app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, total_score, streak FROM users ORDER BY total_score DESC LIMIT 10'
        );
        res.json({ success: true, leaderboard: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Leaderboard failed' });
    }
});

// ============================================================
// 404 + START
// ============================================================
app.use((req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`✅ X-ZITH Backend running on port ${PORT}`);
    console.log(`👤 Creator: Promise Omiyedun — CEO & Founder, X-ZITH Technology`);
    console.log(`🤖 Gemini: ${GEMINI_API_KEY ? 'configured' : '❌'} (${GEMINI_MODEL})`);
    console.log(`⚡ Groq:   ${GROQ_API_KEY ? 'configured' : '❌'} (${GROQ_MODEL})`);
    console.log(`🔍 SerpAPI: ${SERPAPI_KEY ? 'configured' : '❌'}`);
});