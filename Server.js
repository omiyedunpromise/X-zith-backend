/* ============================================================
   X-ZITH Learning Hub — Backend
   Gemini + Groq (auto fallback)  •  Shared in-memory cache
   Validates every AI response before caching
   ============================================================ */

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '8mb' })); // big enough for image uploads

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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-prompt-guard-2-22m';

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ============================================================
// SHARED CACHE (in-memory, LRU-ish)
// ============================================================
const cache = {
    textbook: new Map(),
    pastQuestions: new Map(),
    theoryQuestions: new Map(),
    theoryExplain: new Map(),
    webSearch: new Map(),
    dailyChallenge: new Map(),
    quizArena: new Map()
};

const CACHE_MAX_ENTRIES = 300;

function cacheGet(map, key) {
    const v = map.get(key);
    if (!v) return null;
    map.delete(key);
    map.set(key, v); // LRU touch
    return v;
}
function cacheSet(map, key, value) {
    map.set(key, value);
    if (map.size > CACHE_MAX_ENTRIES) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
    }
}

function sha1(str) {
    return crypto.createHash('sha1').update(String(str)).digest('hex');
}
function todayKey() {
    return new Date().toISOString().slice(0, 10);
}
function weekKey() {
    const d = new Date();
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setUTCDate(diff));
    return monday.toISOString().slice(0, 10);
}

// ============================================================
// RESPONSE VALIDATOR — reject bad AI output before caching
// ============================================================
function validateAI(text, options = {}) {
    const minLength = options.minLength || 40;
    const minWords = options.minWords || 8;
    const requireMarkers = options.requireMarkers || null;

    if (!text || typeof text !== 'string') return { ok: false, reason: 'empty' };
    const t = text.trim();

    // Pure number like 0.001049878541380167, 42, -7.5, 1e-10
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(t)) return { ok: false, reason: 'pure-number' };

    // Placeholder junk
    if (/^(nan|null|undefined|n\/a|error|unknown|none)$/i.test(t)) return { ok: false, reason: 'placeholder' };

    if (t.length < minLength) return { ok: false, reason: 'too-short' };
    if (t.split(/\s+/).length < minWords) return { ok: false, reason: 'too-few-words' };

    // Repeated single char (aaaaaaaa...)
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
    const response = await axios.post(
        url,
        { contents: [{ parts: [{ text: prompt }] }] },
        { timeout }
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned empty response');
    return text;
}

async function callGeminiVision(prompt, imageDataUrl, timeout = 90000) {
    if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
    const m = String(imageDataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid image format');
    const mimeType = m[1];
    const base64Data = m[2];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await axios.post(
        url,
        {
            contents: [{
                parts: [
                    { text: prompt },
                    { inlineData: { mimeType, data: base64Data } }
                ]
            }]
        },
        { timeout }
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini vision returned empty response');
    return text;
}

async function callGroq(prompt, timeout = 60000) {
    if (!groq) throw new Error('Groq API key not configured');
    const completion = await groq.chat.completions.create(
        {
            model: GROQ_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7
        },
        { timeout }
    );
    const text = completion?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Groq returned empty response');
    return text;
}

// Try primary, fall back to the other
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

// Try AI + validate; retry once with the other provider if bad
async function callAIValidated(primary, prompt, timeout, validateOpts) {
    const attempts = [
        primary,
        primary === 'gemini' ? 'groq' : 'gemini',
        primary // last try
    ];
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

// Common warning appended to every prompt
const PROMPT_FOOTER = `

IMPORTANT: Respond with human-readable sentences and paragraphs only. Do NOT respond with a single number, formula, or code. If you cannot produce useful educational content, respond exactly with: "I could not generate this content."`;

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
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
        cache: Object.fromEntries(Object.entries(cache).map(([k, m]) => [k, m.size])),
        timestamp: new Date()
    });
});

// ============================================================
// CACHE STATS + CLEAR
// ============================================================
app.get('/api/cache-stats', (req, res) => {
    res.json({
        success: true,
        cache: Object.fromEntries(Object.entries(cache).map(([k, m]) => [k, m.size]))
    });
});

app.post('/api/clear-cache', (req, res) => {
    const { secret, category } = req.body || {};
    if (secret !== (process.env.CACHE_SECRET || 'xzith-reset-2026')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (category && cache[category]) {
        cache[category].clear();
        return res.json({ success: true, cleared: category });
    }
    Object.values(cache).forEach(m => m.clear());
    res.json({ success: true, cleared: 'all' });
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
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND password_hash = $2',
            [email, passwordHash]
        );
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
// TEXTBOOK  →  Gemini primary, Groq fallback  [CACHED]
// ============================================================
app.post('/api/generate-textbook', async (req, res) => {
    try {
        const { level, subject, topic } = req.body;
        if (!level || !subject || !topic) return res.status(400).json({ error: 'level, subject and topic are required' });
        if (String(topic).trim().length < 3) return res.status(400).json({ error: 'Topic is too short. Please be more specific.' });

        const key = `${level}|${subject}|${topic}`.toLowerCase();
        const cached = cacheGet(cache.textbook, key);
        if (cached) {
            console.log('📦 Textbook cache HIT:', key);
            return res.json({ success: true, note: cached, cached: true });
        }

        const prompt = `You are an expert Nigerian secondary school teacher writing study notes for a ${level} student.

Subject: ${subject}
Topic: ${topic}

Write comprehensive, exam-focused study notes using markdown:
- Start with an introduction (## Introduction)
- Use ## for main headings and ### for sub-headings
- Use bullet points for lists
- Include at least 2 worked examples
- Add a "Key Points to Remember" section
- Add a "Common Exam Mistakes" section
- Add a short "Practice Questions" section with 3 questions
- Target WAEC/NECO/JAMB level
${PROMPT_FOOTER}

Only return the notes in markdown.`;

        const note = await callAIValidated('gemini', prompt, 90000, { minLength: 150, minWords: 30 });

        cacheSet(cache.textbook, key, note);
        console.log('💾 Textbook cached:', key);
        res.json({ success: true, note, cached: false });
    } catch (err) {
        console.error('Textbook error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate usable notes. Please try again.', reason: err.reason });
    }
});

// ============================================================
// PAST QUESTIONS  →  Groq primary, Gemini fallback  [CACHED]
// ============================================================
app.post('/api/generate-past-questions', async (req, res) => {
    try {
        const { exam, year, subject, qtype, count, topic } = req.body;
        if (!exam || !year || !subject) return res.status(400).json({ error: 'exam, year and subject are required' });

        const n = Math.min(parseInt(count) || 10, 20);
        const key = `${exam}|${year}|${subject}|${topic || ''}|${n}`.toLowerCase();
        const cached = cacheGet(cache.pastQuestions, key);
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

Only output the questions. No headings, no intro, no outro.${PROMPT_FOOTER}`;

        const raw = await callAIValidated('groq', prompt, 90000, {
            minLength: 100,
            minWords: 20,
            requireMarkers: [/\bA\)/, /\bAnswer\s*[:\-]/i]
        });

        cacheSet(cache.pastQuestions, key, raw);
        console.log('💾 Past questions cached:', key);
        res.json({ success: true, raw, cached: false });
    } catch (err) {
        console.error('Past questions error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate usable questions. Please try again.', reason: err.reason });
    }
});

// ============================================================
// THEORY QUESTIONS  →  Groq primary, Gemini fallback  [CACHED]
// ============================================================
app.post('/api/generate-theory-question', async (req, res) => {
    try {
        const { exam, subject, count } = req.body;
        if (!exam || !subject) return res.status(400).json({ error: 'exam and subject are required' });

        const n = Math.min(parseInt(count) || 5, 5);
        const key = `${exam}|${subject}|${n}`.toLowerCase();
        const cached = cacheGet(cache.theoryQuestions, key);
        if (cached) {
            console.log('📦 Theory questions cache HIT:', key);
            return res.json({ success: true, questions: cached, cached: true });
        }

        const prompt = `You are a ${exam} examiner in Nigeria.

Generate exactly ${n} theory / essay-style questions for ${subject}.

Format your response like this:

1. First question here with sub-parts (a), (b), (c) where appropriate, each with mark allocations like (5 marks).

2. Second question here with sub-parts...

(continue for all ${n} questions)

Do NOT include answers — only the questions.
Keep them realistic for Nigerian secondary school students.
${PROMPT_FOOTER}`;

        const raw = await callAIValidated('groq', prompt, 90000, { minLength: 120, minWords: 25 });

        cacheSet(cache.theoryQuestions, key, raw);
        console.log('💾 Theory questions cached:', key);
        res.json({ success: true, questions: raw, cached: false });
    } catch (err) {
        console.error('Theory question error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate usable theory questions. Please try again.', reason: err.reason });
    }
});

// ============================================================
// THEORY EXPLANATION  →  Gemini primary, Groq fallback  [CACHED]
// ============================================================
app.post('/api/explain-theory-question', async (req, res) => {
    try {
        const { exam, subject, question } = req.body;
        if (!question) return res.status(400).json({ error: 'question is required' });

        const key = `${exam}|${subject}|${sha1(question)}`.toLowerCase();
        const cached = cacheGet(cache.theoryExplain, key);
        if (cached) {
            console.log('📦 Theory explanation cache HIT');
            return res.json({ success: true, explanation: cached, cached: true });
        }

        const prompt = `You are a Nigerian secondary school ${subject} teacher.

Provide a complete model answer and explanation for this ${exam} theory question:

${question}

Instructions:
- Address each sub-part (a), (b), (c) separately with clear headings
- Show working / steps where needed
- Explain WHY each step is done, not just what to write
- Give exam tips at the end (## Exam Tips)
- Use markdown formatting
${PROMPT_FOOTER}`;

        const explanation = await callAIValidated('gemini', prompt, 90000, { minLength: 100, minWords: 20 });

        cacheSet(cache.theoryExplain, key, explanation);
        console.log('💾 Theory explanation cached');
        res.json({ success: true, explanation, cached: false });
    } catch (err) {
        console.error('Theory explanation error:', err.message, '| reason:', err.reason || '-');
        res.status(502).json({ error: 'AI could not generate a usable explanation. Please try again.', reason: err.reason });
    }
});

// ============================================================
// AI CHAT  →  Gemini (vision if image) primary, Groq fallback
// NOT cached
// ============================================================
app.post('/api/chat', async (req, res) => {
    try {
        const { message, image } = req.body;
        if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message required and must be text' });

        // --- Image path: Gemini vision ---
        if (image && typeof image === 'string' && image.startsWith('data:image/')) {
            try {
                const visionPrompt = `You are an AI tutor helping Nigerian secondary school students prepare for WAEC, NECO and JAMB. The student uploaded an image (likely a question or diagram). Answer clearly, using markdown formatting. If the image contains a question, solve it step by step.

Student's message: ${message}`;
                const reply = await callGeminiVision(visionPrompt, image, 90000);
                return res.json({ success: true, response: reply });
            } catch (err) {
                console.warn('Vision failed, falling back to text-only:', err.message);
                // Fall through to text-only
            }
        }

        // --- Text-only path ---
        const prompt = `You are an AI tutor helping Nigerian secondary school students prepare for WAEC, NECO and JAMB. Answer clearly and use markdown formatting (headings, bullet points, bold for key terms). Question: ${message}${PROMPT_FOOTER}`;
        const reply = await callAI('gemini', prompt, 60000);
        res.json({ success: true, response: reply });
    } catch (err) {
        console.error('Chat error:', err.message);
        res.status(500).json({ error: 'Chat failed: ' + err.message });
    }
});

// ============================================================
// DAILY CHALLENGE  →  Groq  [CACHED PER DAY]
// ============================================================
app.get('/api/daily-challenge', async (req, res) => {
    try {
        const key = todayKey();
        const cached = cacheGet(cache.dailyChallenge, key);
        if (cached) {
            console.log('📦 Daily Challenge cache HIT:', key);
            return res.json({ success: true, challenge: cached, cached: true });
        }

        const prompt = `You are a Nigerian exam question setter.

Create ONE multiple-choice question for today's "Daily Challenge" for WAEC / NECO / JAMB students nationwide.

Pick a random subject from: Mathematics, English Language, Physics, Chemistry, Biology, Economics, Government, Literature in English, Geography, Commerce.

Use EXACTLY this format:

Subject: <subject>
Question: <question text>
A) <option>
B) <option>
C) <option>
D) <option>
Answer: <A|B|C|D>
Explanation: <one short sentence why>
Points: 20

Only output that block. No other text.${PROMPT_FOOTER}`;

        const raw = await callAI('groq', prompt, 60000);

        const get = (re) => { const m = raw.match(re); return m ? m[1].trim() : ''; };
        const challenge = {
            date: key,
            subject: get(/^Subject\s*[:\-]\s*(.+)$/im) || 'General',
            question: get(/^Question\s*[:\-]\s*(.+)$/im) || '',
            options: [
                { letter: 'A', text: get(/^A\)\s*(.+)$/im) },
                { letter: 'B', text: get(/^B\)\s*(.+)$/im) },
                { letter: 'C', text: get(/^C\)\s*(.+)$/im) },
                { letter: 'D', text: get(/^D\)\s*(.+)$/im) }
            ].filter(o => o.text),
            answer: (get(/^Answer\s*[:\-]\s*([A-D])/im) || 'A').toUpperCase(),
            explanation: get(/^Explanation\s*[:\-]\s*(.+)$/im) || '',
            points: parseInt(get(/^Points\s*[:\-]\s*(\d+)/im)) || 20
        };

        const okChallenge =
            challenge.question.length > 15 &&
            challenge.options.length >= 2 &&
            /^[A-D]$/.test(challenge.answer);

        if (!okChallenge) {
            console.error('❌ Daily Challenge bad:', JSON.stringify(challenge).slice(0, 200));
            return res.status(502).json({ error: 'AI returned an unusable challenge. Please try again.' });
        }

        cacheSet(cache.dailyChallenge, key, challenge);
        console.log('💾 Daily Challenge cached for', key);
        res.json({ success: true, challenge, cached: false });
    } catch (err) {
        console.error('Daily Challenge error:', err.message);
        res.status(500).json({ error: 'Failed to load daily challenge: ' + err.message });
    }
});

// ============================================================
// QUIZ ARENA  →  Groq  [CACHED PER WEEK]
// ============================================================
app.post('/api/quiz-arena', async (req, res) => {
    try {
        const key = weekKey();
        const cached = cacheGet(cache.quizArena, key);
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

Only output the questions with the header above. No other text.${PROMPT_FOOTER}`;

        const raw = await callAI('groq', prompt, 90000);

        const subjectMatch = raw.match(/^Subject\s*[:\-]\s*(.+)$/im);
        const topicMatch = raw.match(/^Topic\s*[:\-]\s*(.+)$/im);
        const body = raw
            .replace(/^Subject\s*[:\-].+$/im, '')
            .replace(/^Topic\s*[:\-].+$/im, '')
            .trim();

        const check = validateAI(body, {
            minLength: 150,
            minWords: 30,
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

        cacheSet(cache.quizArena, key, arena);
        console.log('💾 Quiz Arena cached for week', key);
        res.json({ success: true, questions: arena, cached: false });
    } catch (err) {
        console.error('Quiz Arena error:', err.message);
        res.status(500).json({ error: 'Failed to load quiz arena: ' + err.message });
    }
});

// ============================================================
// WEB SEARCH  →  SerpAPI  [CACHED]
// ============================================================
app.post('/api/search', async (req, res) => {
    try {
        const { q } = req.body;
        if (!q || typeof q !== 'string') return res.status(400).json({ error: 'Query required and must be text' });
        if (!SERPAPI_KEY) return res.status(500).json({ error: 'SerpAPI key not configured' });

        const key = q.trim().toLowerCase();
        const cached = cacheGet(cache.webSearch, key);
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

        cacheSet(cache.webSearch, key, formatted);
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
app.listen(PORT, () => {
    console.log(`✅ X-ZITH Backend running on port ${PORT}`);
    console.log(`👤 Creator: Promise Omiyedun — CEO & Founder, X-ZITH Technology`);
    console.log(`🤖 Gemini:     ${GEMINI_API_KEY ? 'configured' : '❌ MISSING'} (model: ${GEMINI_MODEL})`);
    console.log(`⚡ Groq:       ${GROQ_API_KEY ? 'configured' : '❌ MISSING'} (model: ${GROQ_MODEL})`);
    console.log(`🔍 SerpAPI:    ${SERPAPI_KEY ? 'configured' : '❌ MISSING'}`);
    console.log(`📦 Cache:      textbook / past questions / theory / web search / daily challenge / quiz arena`);
    console.log(`🛡️  Validation: rejects pure numbers, empty, and malformed AI output before caching`);
});
