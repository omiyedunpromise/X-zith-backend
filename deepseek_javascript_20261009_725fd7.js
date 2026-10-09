/* ============================================================
   X-ZITH Learning Hub — Backend (full updated)
   Gemini + Groq (auto fallback)  •  Persistent DB cache
   Theory from DB  •  Daily Challenge from DB  •  AI Tutor chat saved
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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
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
- Answer clearly, using markdown formatting (headings, bullet points, **bold** for key terms, tables where useful).
- Be warm, encouraging, and exam-focused.
- If the student uploads a photo of a question, read it carefully and solve it step by step.

FORMATTING RULES FOR ALL ANSWERS:
- Use markdown tables (| col | col |) when comparing things or listing types.
- Use a simple ASCII diagram inside a fenced code block when showing a process, structure, cycle, or relationship.
- For calculations, write them the way a teacher writes on the board — one line per step, keeping the equals sign aligned, and showing every step. Never skip steps.`;

// ============================================================
// PERSISTENT DB CACHE
// ============================================================
async function dbCacheGet(category, key) {
    try {
        const fullKey = category + '|' + key;
        const result = await pool.query(
            'SELECT content FROM ai_cache WHERE cache_key = $1',
            [fullKey]
        );
        if (result.rows.length > 0) {
            pool.query(
                'UPDATE ai_cache SET hit_count = hit_count + 1 WHERE cache_key = $1',
                [fullKey]
            ).catch(() => {});
            return result.rows[0].content;
        }
        return null;
    } catch (err) {
        console.error('Cache read error:', err.message);
        return null;
    }
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
    } catch (err) {
        console.error('Cache write error:', err.message);
    }
}

async function dbCacheStats() {
    try {
        const result = await pool.query(
            'SELECT category, COUNT(*)::int AS count FROM ai_cache GROUP BY category'
        );
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
function sha1(str) {
    return crypto.createHash('sha1').update(String(str)).digest('hex');
}
function todayKey() {
    const now = new Date(Date.now() + 60 * 60 * 1000);
    return now.toISOString().slice(0, 10);
}
function weekKey() {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setUTCDate(diff));
    return monday.toISOString().slice(0, 10);
}

// ============================================================
// AI RESPONSE VALIDATOR
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
            console.warn(`⚠️ Attempt ${i + 1} rejected (${check.reason}).`);
        } catch (err) {
            lastReason = err.message;
            console.warn(`⚠️ Attempt ${i + 1} threw: ${err.message}`);
        }
    }
    const e = new Error('AI could not produce a valid response. Please try again.');
    e.reason = lastReason || 'all-attempts-failed';
    throw e;
}

const PROMPT_FOOTER = `

FORMATTING RULES:
- Respond with human-readable sentences and paragraphs only.
- Never respond with a single number, formula, or code.
- Use markdown tables (| col | col |) when comparing things or listing types.
- Use a simple ASCII diagram inside a fenced code block when showing a process, structure, cycle, or relationship.
- For calculations, write them the way a teacher writes on the board — one line per step, aligned equals signs, showing every step. Never skip steps.
- If you cannot produce useful educational content, respond exactly with: "I could not generate this content."`;

// ============================================================
// HEALTH CHECK
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
            gemini: !!GEMINI_API_KEY,
            groq: !!GROQ_API_KEY,
            serpapi: !!SERPAPI_KEY
        },
        cache: stats,
        timestamp: new Date()
    });
});

// ============================================================
// CACHE STATS + CLEAR
// ============================================================
app.get('/api/cache-stats', async (req, res) => {
    const stats = await dbCacheStats();
    res.json({ success: true, cache: stats });
});

app.post('/api/clear-cache', async (req, res) => {
    const { secret, category } = req.body || {};
    if (secret !== (process.env.CACHE_SECRET || 'xzith-reset-2026')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const ok = await dbCacheClear(category);
    if (ok) res.json({ success: true, cleared: category || 'all' });
    else res.status(500).json({ error: 'Failed to clear cache' });
});

// ============================================================
// ABOUT
// ============================================================
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
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

app.post('/api/signup', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) return res.status(400).json({ success: false, error: 'All fields required' });
        if (password.length < 6) return res.status(400).json({ success: false, error: 'Password must be 6+ characters' });

        const passwordHash = hashPassword(password);
        const today = new Date().toISOString().split('T')[0];
        const query = `
            INSERT INTO users (username, email, password_hash, total_score, quizzes_taken, exam_questions, streak, created_at)
            VALUES ($1, $2, $3, 0, 0, 0, 1, $4)
            RETURNING id, username, email, total_score, quizzes_taken, exam_questions, streak
        `;
        const result = await pool.query(query, [username, email, passwordHash, today]);
        if (result.rows.length > 0) res.json({ success: true, message: 'Account created! Please login.', user: result.rows[0] });
    } catch (err) {
        console.error('Signup error:', err.message);
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
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed: ' + err.message });
    }
});

// ============================================================
// PUSH THEORY (from Colab)
// ============================================================
app.post('/api/push-theory', async (req, res) => {
    try {
        const { secret, theory } = req.body || {};
        const PUSH_SECRET = process.env.PUSH_SECRET || 'xzith-push-2026';
        if (secret !== PUSH_SECRET) return res.status(403).json({ error: 'Forbidden — wrong push secret' });
        if (!theory || typeof theory !== 'object') return res.status(400).json({ error: 'Missing "theory" object in body' });

        let total = 0;
        const inserted = [];

        for (const exam of Object.keys(theory)) {
            const subjects = theory[exam];
            for (const subject of Object.keys(subjects)) {
                const questions = subjects[subject];
                if (!Array.isArray(questions) || questions.length === 0) continue;
                await pool.query(
                    `INSERT INTO theory_questions (exam, subject, questions)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (exam, subject) DO UPDATE
                     SET questions = EXCLUDED.questions, created_at = NOW()`,
                    [exam, subject, JSON.stringify(questions)]
                );
                inserted.push({ exam, subject, count: questions.length });
                total += questions.length;
            }
        }

        console.log(`💾 Theory pushed: ${inserted.length} rows, ${total} questions`);
        res.json({ success: true, message: 'Theory questions stored', total, subjects: inserted.length, details: inserted });
    } catch (err) {
        console.error('Push theory error:', err.message);
        res.status(500).json({ error: 'Failed to store theory questions: ' + err.message });
    }
});

// ============================================================
// PUSH DAILY CHALLENGE (from Colab)
// ============================================================
app.post('/api/push-daily', async (req, res) => {
    try {
        const { secret, daily } = req.body || {};
        const PUSH_SECRET = process.env.PUSH_SECRET || 'xzith-push-2026';
        if (secret !== PUSH_SECRET) return res.status(403).json({ error: 'Forbidden — wrong push secret' });
        if (!daily || typeof daily !== 'object') return res.status(400).json({ error: 'Missing "daily" object in body' });

        let total = 0;
        for (const exam of Object.keys(daily)) {
            const questions = daily[exam];
            if (!Array.isArray(questions) || questions.length === 0) continue;
            await pool.query(
                `INSERT INTO daily_questions (exam, questions)
                 VALUES ($1, $2)
                 ON CONFLICT (exam) DO UPDATE
                 SET questions = EXCLUDED.questions, created_at = NOW()`,
                [exam, JSON.stringify(questions)]
            );
            total += questions.length;
        }
        console.log(`💾 Daily pushed: ${total} questions`);
        res.json({ success: true, message: 'Daily questions stored', total });
    } catch (err) {
        console.error('Push daily error:', err.message);
        res.status(500).json({ error: 'Failed to store daily questions: ' + err.message });
    }
});

// ============================================================
// TEXTBOOK  →  Gemini primary, Groq fallback  [DB CACHED]
// ============================================================
app.post('/api/generate-textbook', async (req, res) => {
    try {
        const { level, subject, topic } = req.body;
        if (!level || !subject || !topic) return res.status(400).json({ error: 'level, subject and topic are required' });
        if (String(topic).trim().length < 3) return res.status(400).json({ error: 'Topic is too short. Please be more specific.' });

        const key = `${level}|${subject}|${topic}`.toLowerCase();
        const cached = await dbCacheGet('textbook', key);
        if (cached) {
            console.log('📦 Textbook cache HIT:', key);
            return res.json({ success: true, note: cached, cached: true });
        }

        const prompt = `You are an experienced Nigerian secondary school teacher writing a comprehensive chapter for a ${level} student.

Subject: ${subject}
Topic: ${topic}

You MUST produce a full, detailed textbook chapter (at least 500 words). Follow this structure EXACTLY:

## Introduction
A full paragraph explaining what ${topic} is and why it matters in ${subject}.

## Definition
A clear formal definition with an example.

## Types / Kinds
List and explain every main type of ${topic}. Use a markdown table when comparing them.

## Rules and Usage
Explain the rules with at least 3 example sentences.

## Worked Examples
Provide 2 full worked examples with step-by-step explanations.
- If the topic involves calculation, write each step on its own line, keeping the equals sign aligned the way a teacher writes on the board.
- Never skip steps.

## Diagrams / Illustrations
If ${topic} involves a structure, process, cycle, or relationship, include a simple ASCII diagram inside a fenced code block. If not applicable, skip this section.

## Key Points to Remember
A bulleted summary.

## Common Exam Mistakes
3 mistakes WAEC/NECO/JAMB students make, and how to avoid them.

## Practice Questions
3 practice questions with their answers.
${PROMPT_FOOTER}

Return the chapter in markdown.`;

        const note = await callAIValidated('gemini', prompt, 90000, { minLength: 150, minWords: 30 });
        await dbCacheSet('textbook', key, note);
        console.log('💾 Textbook saved:', key);
        res.json({ success: true, note, cached: false });
    } catch (err) {
        console.error('Textbook error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate usable notes. Please try again.', reason: err.reason });
    }
});

// ============================================================
// PAST QUESTIONS  →  Groq primary, Gemini fallback  [DB CACHED]
// ============================================================
app.post('/api/generate-past-questions', async (req, res) => {
    try {
        const { exam, year, subject, qtype, count, topic } = req.body;
        if (!exam || !year || !subject) return res.status(400).json({ error: 'exam, year and subject are required' });

        const n = Math.min(parseInt(count) || 10, 20);
        const key = `${exam}|${year}|${subject}|${topic || ''}|${n}`.toLowerCase();
        const cached = await dbCacheGet('pastQuestions', key);
        if (cached) {
            console.log('📦 Past questions cache HIT:', key);
            return res.json({ success: true, raw: cached, cached: true });
        }

        const topicLine = topic ? `Focus on the topic: "${topic}".` : '';
        const prompt = `You are a ${exam} examiner in Nigeria setting a ${year} paper.

Generate exactly ${n} ${qtype || 'Objective'} questions for ${subject}. ${topicLine}

Use EXACTLY this format for every question, no extra commentary:

1. Full question text here?
A) option one
B) option two
C) option three
D) option four
Answer: A
Explanation: One-sentence reason why this is correct.

2. Next question...
A) ...
B) ...
C) ...
D) ...
Answer: ...
Explanation: ...

Only output the questions. No headings, no intro, no outro.`;

        const raw = await callAIValidated('groq', prompt, 90000, {
            minLength: 100, minWords: 20,
            requireMarkers: [/\bA\)/, /\bAnswer\s*[:\-]/i]
        });

        await dbCacheSet('pastQuestions', key, raw);
        console.log('💾 Past questions saved:', key);
        res.json({ success: true, raw, cached: false });
    } catch (err) {
        console.error('Past questions error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate usable questions. Please try again.', reason: err.reason });
    }
});

// ============================================================
// THEORY QUESTIONS — READ FROM DB (pushed from Colab)
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

        res.json({
            success: true,
            questions: parsed,
            source: 'db',
            stored_at: result.rows[0].created_at
        });
    } catch (err) {
        console.error('Theory fetch error:', err.message);
        res.status(500).json({ error: 'Failed to load theory questions: ' + err.message });
    }
});

// ============================================================
// THEORY EXPLANATION — 5-STEP STRUCTURE  [DB CACHED]
// ============================================================
app.post('/api/explain-theory-question', async (req, res) => {
    try {
        const { exam, subject, question } = req.body;
        if (!question) return res.status(400).json({ error: 'question is required' });

        const key = `${exam}|${subject}|${sha1(question)}`.toLowerCase();
        const cached = await dbCacheGet('theoryExplain', key);
        if (cached) {
            console.log('📦 Theory explanation cache HIT');
            return res.json({ success: true, explanation: cached, cached: true });
        }

        const prompt = `${AI_TUTOR_IDENTITY}

You are answering as AI Tutor. Provide a complete model answer for this ${exam} ${subject} theory question:

QUESTION:
${question}

Return your answer in EXACTLY this 5-section structure using these headings:

## 1. Step-by-Step Explanation
Break the question down. Explain what the examiner is actually asking, and walk through the reasoning from the beginning. If the question has sub-parts (a), (b), (c), treat each one separately with its own mini-explanation.
- For calculation questions, write each step on its own line, with aligned equals signs, the way a teacher writes on the board. Show every single step. Never skip steps.

## 2. Key Points That Earn Marks
A bulleted list of the specific points the examiner is looking for. Each bullet is a mark-scoring point.
- Include diagrams (inside fenced code blocks) if a diagram earns marks.
- Include a markdown table if comparing multiple things.

## 3. Model Answer
The complete answer exactly as a top student would write it in the exam. This should be ready to write down — full sentences, proper structure, all sub-parts answered.

## 4. Common Mistakes Students Make
A bulleted list of the mistakes WAEC/NECO students typically make on this type of question, and how to avoid them.

## 5. How to Remember the Answer
A short memory aid — a mnemonic, acronym, or simple pattern that helps the student recall the answer in the exam hall.

${PROMPT_FOOTER}`;

        const explanation = await callAIValidated('gemini', prompt, 120000, { minLength: 200, minWords: 40 });

        await dbCacheSet('theoryExplain', key, explanation);
        console.log('💾 Theory explanation saved');
        res.json({ success: true, explanation, cached: false });
    } catch (err) {
        console.error('Theory explanation error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate a usable explanation. Please try again.', reason: err.reason });
    }
});

// ============================================================
// AI CHAT  →  Gemini vision primary, Groq fallback
// Chat history saved per user
// ============================================================

app.get('/api/chat-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await pool.query(
            `SELECT id, role, content, has_image, created_at
             FROM chat_history
             WHERE user_id = $1
             ORDER BY created_at ASC
             LIMIT 200`,
            [userId]
        );
        res.json({ success: true, messages: result.rows });
    } catch (err) {
        console.error('Chat history error:', err.message);
        res.status(500).json({ error: 'Failed to load chat history' });
    }
});

app.delete('/api/chat-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        await pool.query('DELETE FROM chat_history WHERE user_id = $1', [userId]);
        res.json({ success: true, cleared: true });
    } catch (err) {
        console.error('Clear chat error:', err.message);
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

The student uploaded an image (likely a question or diagram). Read it carefully and solve or explain step by step.

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
        console.error('Chat error:', err.message);
        res.status(500).json({ error: 'Chat failed: ' + err.message });
    }
});

// ============================================================
// DAILY CHALLENGE — READ FROM DB, ONE PER DAY, CYCLES
// ============================================================
app.get('/api/daily-challenge', async (req, res) => {
    try {
        const rows = await pool.query('SELECT exam, questions FROM daily_questions');
        if (rows.rows.length === 0) {
            return res.status(404).json({ error: 'No daily questions pushed yet.' });
        }

        const allQuestions = [];
        rows.rows.forEach(r => {
            const qs = Array.isArray(r.questions) ? r.questions : JSON.parse(r.questions);
            qs.forEach(q => allQuestions.push(q));
        });
        if (allQuestions.length === 0) {
            return res.status(404).json({ error: 'Daily question bank is empty.' });
        }

        // One per day — deterministic, same for everyone, cycles through the bank
        const dateStr = todayKey();
        const dayNumber = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / (1000 * 60 * 60 * 24));
        const today = allQuestions[dayNumber % allQuestions.length];

        res.json({
            success: true,
            challenge: {
                ...today,
                date: dateStr
            }
        });
    } catch (err) {
        console.error('Daily challenge error:', err.message);
        res.status(500).json({ error: 'Failed to load daily challenge: ' + err.message });
    }
});

// ============================================================
// QUIZ ARENA  →  Groq  [DB CACHED PER WEEK]
// ============================================================
app.post('/api/quiz-arena', async (req, res) => {
    try {
        const key = weekKey();
        const cached = await dbCacheGet('quizArena', key);
        if (cached) {
            console.log('📦 Quiz Arena cache HIT:', key);
            return res.json({ success: true, questions: cached, cached: true });
        }

        const prompt = `You are a Nigerian exam question setter.

Create a "Quiz Arena" — FIVE multiple-choice questions for this week's challenge for WAEC / NECO / JAMB students.

Pick ONE random subject from: Mathematics, English Language, Physics, Chemistry, Biology, Economics, Government, Literature in English, Geography, Commerce.
Then pick a specific topic within that subject.
Generate 5 questions on that topic.

Format:

Subject: <subject>
Topic: <topic>

1. <question>?
A) <option>
B) <option>
C) <option>
D) <option>
Answer: <A|B|C|D>
Explanation: <one short sentence>

2. <question>?
A) ...
B) ...
C) ...
D) ...
Answer: ...
Explanation: ...

(continue for 5 questions)

Only output the questions with the header above. No other text.`;

        const raw = await callAI('groq', prompt, 90000);

        const subjectMatch = raw.match(/^Subject\s*[:\-]\s*(.+)$/im);
        const topicMatch = raw.match(/^Topic\s*[:\-]\s*(.+)$/im);
        const body = raw
            .replace(/^Subject\s*[:\-].+$/im, '')
            .replace(/^Topic\s*[:\-].+$/im, '')
            .trim();

        const check = validateAI(body, {
            minLength: 150, minWords: 30,
            requireMarkers: [/\bA\)/, /\bAnswer\s*[:\-]/i]
        });
        if (!check.ok) {
            console.error(`❌ Quiz Arena bad (${check.reason}):`, body.slice(0, 150));
            return res.status(502).json({ error: 'AI returned an unusable quiz. Please try again.', reason: check.reason });
        }

        const arena = {
            week: key,
            subject: subjectMatch ? subjectMatch[1].trim() : 'General',
            topic: topicMatch ? topicMatch[1].trim() : '',
            questions: body
        };

        await dbCacheSet('quizArena', key, arena);
        console.log('💾 Quiz Arena saved for week', key);
        res.json({ success: true, questions: arena, cached: false });
    } catch (err) {
        console.error('Quiz Arena error:', err.message);
        res.status(500).json({ error: 'Failed to load quiz arena: ' + err.message });
    }
});

// ============================================================
// WEB SEARCH  →  SerpAPI  [DB CACHED]
// ============================================================
app.post('/api/search', async (req, res) => {
    try {
        const { q } = req.body;
        if (!q || typeof q !== 'string') return res.status(400).json({ error: 'Query required and must be text' });
        if (!SERPAPI_KEY) return res.status(500).json({ error: 'SerpAPI key not configured' });

        const key = q.trim().toLowerCase();
        const cached = await dbCacheGet('webSearch', key);
        if (cached) {
            console.log('📦 Web search cache HIT:', key);
            return res.json({ success: true, results: cached, cached: true });
        }

        const response = await axios.get('https://serpapi.com/search', {
            params: { q, api_key: SERPAPI_KEY, engine: 'google', num: 5 },
            timeout: 30000
        });

        const results = response.data.organic_results?.slice(0, 5) || [];
        const formatted = results.map(r => ({ title: r.title, snippet: r.snippet, link: r.link }));

        if (!Array.isArray(formatted) || formatted.length === 0) {
            return res.status(502).json({ error: 'No search results. Please try a different query.' });
        }

        await dbCacheSet('webSearch', key, formatted);
        res.json({ success: true, results: formatted, cached: false });
    } catch (err) {
        console.error('Search error:', err.message);
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
        console.error('Leaderboard error:', err.message);
        res.status(500).json({ error: 'Leaderboard failed' });
    }
});

// ============================================================
// 404 FALLBACK
// ============================================================
app.use((req, res) => {
    res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ============================================================
// SERVER START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`✅ X-ZITH Backend running on port ${PORT}`);
    console.log(`👤 Creator: Promise Omiyedun — CEO & Founder, X-ZITH Technology`);
    console.log(`🤖 Gemini:     ${GEMINI_API_KEY ? 'configured' : '❌ MISSING'} (model: ${GEMINI_MODEL})`);
    console.log(`⚡ Groq:       ${GROQ_API_KEY ? 'configured' : '❌ MISSING'} (model: ${GROQ_MODEL})`);
    console.log(`🔍 SerpAPI:    ${SERPAPI_KEY ? 'configured' : '❌ MISSING'}`);
    console.log(`🗄️  Tables:     ai_cache, theory_questions, chat_history, daily_questions`);

    try {
        const r1 = await pool.query('SELECT COUNT(*)::int AS count FROM ai_cache');
        const r2 = await pool.query('SELECT COUNT(*)::int AS count FROM theory_questions');
        const r3 = await pool.query('SELECT COUNT(*)::int AS count FROM chat_history');
        const r4 = await pool.query('SELECT COUNT(*)::int AS count FROM daily_questions');
        console.log(`📦 ai_cache:           ${r1.rows[0].count}`);
        console.log(`📖 theory_questions:   ${r2.rows[0].count}`);
        console.log(`💬 chat_history:       ${r3.rows[0].count}`);
        console.log(`🎯 daily_questions:    ${r4.rows[0].count}`);
    } catch (err) {
        console.error('⚠️  Tables missing. Run the SQL from db.sql first.');
        console.error('   Error:', err.message);
    }
});