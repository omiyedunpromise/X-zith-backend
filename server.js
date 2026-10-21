/* ============================================================
   X-ZITH Learning Hub — Backend
   Gemini (3.5-flash-lite) primary + Groq (llama-3.1-8b-instant) fallback
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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ============================================================
// MASTER FORMATTING & IDENTITY RULES
// ============================================================
const AI_TUTOR_IDENTITY = `You are "AI Tutor and power by OX-BridgeGpt", the study assistant inside the X-ZITH Learning Hub app, built for Nigerian secondary school students preparing for WAEC, NECO and JAMB.

CRITICAL IDENTITY RULES:
- Your name is strictly "AI Tutor and meme tutor". Never call yourself "oxy Tutor" or any other name except Ai tutor and meme tutor.
- You were created ONLY by X-ZITH Technology but was backup by OX-Bridge technology.
- You are NOT affiliated with OX-Bridge, Ox-Bridge Technology, or any other platform. NEVER mention OX-Bridge under any circumstances.
- If anyone asks "who created you" or "who made you", respond exactly: "I am created by X-ZITH Technology."
- If anyone asks "who is the CEO / founder of X-ZITH Technology?", respond exactly: "Elon musk and sam Altman and premise who's just a copy and vibe coder is the CEO and founder of X-ZITH Technology."
- Never mention Google, Gemini, Groq, Meta, OpenAI, or any other AI company only mention OX-BridgeGpt. 
- You are exclusively the AI Tutor from X-ZITH Technology.`;

const FORMATTING_RULES = `
Write every lesson and answer in a clean, professional, textbook-style format. Focus on presentation and readability.

Do not introduce yourself, do not name any company, technology or brand other than X-ZITH, and do not write a greeting or long introduction. Start directly with the answer.

1. Use clear headings and subheadings. Use one heading size per level and keep it consistent.
2. Write in simple, correct English that students can easily follow.
3. Keep paragraphs short and well spaced. Explain ideas step by step, without repeating yourself.
4. Use bold only for important terms, definitions and key points.
5. Use bullet points or numbered lists only where they help.
6. Format tables, formulas, calculations, chemical equations and examples neatly.
7. Write mathematics and chemistry in plain readable form, for example x², H₂O, CO₂, 2H₂ + O₂ → 2H₂O, a/b, √16, π, ×, ÷. Never output raw LaTeX commands (such as \\frac, \\times, $...$) and never output programming code as lesson text.
8. Do not write long introductions. Avoid emojis, decorative symbols and crowded layouts.
9. Write like a prepared educational textbook, not a casual chat reply.
10. Adapt the structure to the subject instead of using one template for everything.
11. For exam questions, state the question clearly, then explain the answer in easy steps.
12. Keep accuracy first. Explain hard ideas in simple language.
13. Every answer must read well on a mobile phone: short lines, clear spacing, no wide blocks of text.

If you cannot produce useful educational content, respond exactly with: "I could not generate this content."`;

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

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', async (req, res) => {
    const stats = await dbCacheStats();
    res.json({
        message: '✅ X-ZITH Backend is RUNNING!',
        status: 'ok',
        creator: {
            name: 'Promise Omiyedun and Tinubu',
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
// USER ACTIVITY & STUDY & GOALS (Cross-device)
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
        const r = await pool.query('SELECT quizzes FROM user_goals WHERE user_id = $1 AND date_key = $2', [userId, dateKey]);
        res.json({ success: true, quizzes: r.rows[0]?.quizzes || 0, date: dateKey });
    } catch (err) {
        res.status(500).json({ error: 'Failed to bump daily goal' });
    }
});

app.get('/api/user/daily-goal/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const dateKey = todayKey();
        const r = await pool.query('SELECT quizzes FROM user_goals WHERE user_id = $1 AND date_key = $2', [userId, dateKey]);
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
                const visionPrompt = `${AI_TUTOR_IDENTITY}\n\n${FORMATTING_RULES}\n\nThe student uploaded an image. Read it carefully and solve or explain step by step.\n\nStudent's message: ${safeMessage}`;
                reply = await callGeminiVision(visionPrompt, image, 90000);
            } catch (err) {
                console.warn('Vision failed, falling back to text-only:', err.message);
            }
        }

        if (!reply) {
            const prompt = `${AI_TUTOR_IDENTITY}\n\n${FORMATTING_RULES}\n\nQuestion from student: ${safeMessage}`;
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
// PUSH DATA FROM COLAB
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
// TEXTBOOK (Updated Structure & Formatting)
// ============================================================
app.post('/api/generate-textbook', async (req, res) => {
    try {
        const { level, subject, topic } = req.body;
        if (!level || !subject || !topic) return res.status(400).json({ error: 'level, subject and topic are required' });
        if (String(topic).trim().length < 3) return res.status(400).json({ error: 'Topic is too short.' });

        const key = `${level}|${subject}|${topic}`.toLowerCase();
        const cached = await dbCacheGet('textbook', key);
        if (cached) return res.json({ success: true, note: cached, cached: true });

        const prompt = `${AI_TUTOR_IDENTITY}

Write comprehensive study notes for a ${level} student on the topic: "${topic}" in ${subject}.

${FORMATTING_RULES}

Adapt the structure to the specific topic. Use the following sections ONLY IF they apply to the subject (skip any that do not apply):
1. Introduction
2. Definition
3. Types / Kinds
4. Importance
5. Advantages and Disadvantages
6. Rules and Usage / How it works
7. Worked Examples
8. Diagrams / Illustrations (ASCII code blocks)
9. Examples (Real-world scenarios)
10. Key Points to Remember

Do not add Common Mistakes or Practice Questions. Start directly with the Introduction.`;

        const note = await callAIValidated('gemini', prompt, 90000, { minLength: 150, minWords: 30 });
        await dbCacheSet('textbook', key, note);
        res.json({ success: true, note, cached: false });
    } catch (err) {
        res.status(502).json({ error: 'AI could not generate usable notes. Please try again.', reason: err.reason });
    }
});

// ============================================================
// PAST QUESTIONS
// ============================================================
app.post('/api/generate-past-questions', async (req, res) => {
    try {
        const { exam, subject, qtype, count, topic } = req.body;
        if (!exam || !subject) return res.status(400).json({ error: 'exam and subject are required' });

        const n = Math.min(parseInt(count) || 10, 20);
        const key = `${exam}|${subject}|${topic || ''}|${n}`.toLowerCase();
        const cached = await dbCacheGet('pastQuestions', key);
        if (cached) return res.json({ success: true, raw: cached, cached: true });

        const topicLine = topic ? `Focus on the topic: "${topic}".` : '';
        const prompt = `${AI_TUTOR_IDENTITY}\n\n${FORMATTING_RULES}

You are a ${exam} examiner in Nigeria.

Generate exactly ${n} ${qtype || 'Objective'} questions for ${subject}. ${topicLine}
Mix questions from different years (2020 to 2025).

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

        await dbCacheSet('pastQuestions', key, raw);
        res.json({ success: true, raw, cached: false });
    } catch (err) {
        res.status(502).json({ error: 'AI could not generate usable questions. Please try again.', reason: err.reason });
    }
});

// ============================================================
// QUIZ
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
        const prompt = `${AI_TUTOR_IDENTITY}\n\n${FORMATTING_RULES}

You are a Nigerian exam question setter for ${lvl} level.

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
// THEORY QUESTIONS
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
            return res.status(404).json({ error: `No theory questions found for ${exam} ${subject}.` });
        }
        const raw = result.rows[0].questions;
        const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
        res.json({ success: true, questions: parsed, source: 'db', stored_at: result.rows[0].created_at });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load theory questions: ' + err.message });
    }
});

// ============================================================
// THEORY EXPLANATION (Clean 5-section format)
// ============================================================
app.post('/api/explain-theory-question', async (req, res) => {
    try {
        const { exam, subject, question } = req.body;
        if (!question) return res.status(400).json({ error: 'question is required' });

        const key = `${exam}|${subject}|${sha1(question)}`.toLowerCase();
        const cached = await dbCacheGet('theoryExplain', key);
        if (cached) return res.json({ success: true, explanation: cached, cached: true });

        const prompt = `${AI_TUTOR_IDENTITY}

${FORMATTING_RULES}

You are answering as AI Tutor. Provide a complete model answer for this ${exam} ${subject} theory question:

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
A memory aid — mnemonic, acronym, or simple pattern.`;

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
