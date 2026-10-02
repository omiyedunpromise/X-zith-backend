const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
const Groq = require('groq-sdk');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '2mb' }));

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

const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SERPAPI_KEY        = process.env.SERPAPI_KEY;

const GEMINI_MODEL       = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GROQ_MODEL         = process.env.GROQ_MODEL   || 'gtp-oss20b';
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'Gemma-4-26B-and-31B-variants';

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// ============================================================
// HELPERS
// ============================================================
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// --- Gemini ---
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

// --- Groq ---
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

// --- OpenRouter (fallback) ---
async function callOpenRouter(prompt, timeout = 90000) {
  if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key not configured');
  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    },
    {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://x-zith-backend.onrender.com',
        'X-Title': 'X-ZITH Learning Hub'
      },
      timeout
    }
  );
  const text = response.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenRouter returned empty response');
  return text;
}

// --- Smart caller: primary → fallback ---
async function callAI(primary, prompt, timeout) {
  try {
    if (primary === 'gemini') return await callGemini(prompt, timeout);
    if (primary === 'groq')   return await callGroq(prompt, timeout);
    throw new Error('Unknown provider: ' + primary);
  } catch (err) {
    console.warn(`⚠️ ${primary} failed (${err.message}). Falling back to OpenRouter...`);
    try {
      return await callOpenRouter(prompt, timeout);
    } catch (fallbackErr) {
      console.error(`❌ OpenRouter fallback also failed: ${fallbackErr.message}`);
      throw new Error(`${primary} failed: ${err.message}. Fallback failed: ${fallbackErr.message}`);
    }
  }
}

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
      gemini:     !!GEMINI_API_KEY,
      groq:       !!GROQ_API_KEY,
      openrouter: !!OPENROUTER_API_KEY,
      serpapi:    !!SERPAPI_KEY
    },
    routes: [
      'POST /api/signup', 'POST /api/login',
      'POST /api/chat (Gemini → OpenRouter)',
      'POST /api/generate-textbook (Gemini → OpenRouter)',
      'POST /api/generate-past-questions (Groq → OpenRouter)',
      'POST /api/generate-theory-question (Groq → OpenRouter)',
      'POST /api/explain-theory-question (Gemini → OpenRouter)',
      'POST /api/search (SerpAPI)',
      'GET  /api/leaderboard',
      'GET  /api/about'
    ],
    timestamp: new Date()
  });
});

// ============================================================
// ABOUT / CREATOR INFO
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
app.post('/api/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be 6+ characters' });
    }

    const passwordHash = hashPassword(password);
    const today = new Date().toISOString().split('T')[0];

    const query = `
      INSERT INTO users (username, email, password_hash, total_score, quizzes_taken, exam_questions, streak, created_at)
      VALUES ($1, $2, $3, 0, 0, 0, 1, $4)
      RETURNING id, username, email, total_score, quizzes_taken, exam_questions, streak
    `;
    const result = await pool.query(query, [username, email, passwordHash, today]);

    if (result.rows.length > 0) {
      res.json({ success: true, message: 'Account created! Please login.', user: result.rows[0] });
    }
  } catch (err) {
    console.error('Signup error:', err);
    if (err.code === '23505') {
      res.status(400).json({ success: false, error: 'Username or email already exists' });
    } else {
      res.status(500).json({ error: 'Signup failed: ' + err.message });
    }
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

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
    } else {
      res.status(401).json({ success: false, error: 'Invalid email or password' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// ============================================================
// AI CHAT  →  Gemini → OpenRouter
// ============================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message required and must be text' });
    }

    const prompt = `You are an AI tutor helping Nigerian secondary school students prepare for WAEC, NECO and JAMB. Answer clearly and use markdown formatting (headings, bullet points, bold key terms). Question: ${message}`;
    const reply = await callAI('gemini', prompt, 60000);

    res.json({ success: true, response: reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat failed: ' + err.message });
  }
});

// ============================================================
// TEXTBOOK GENERATOR  →  Gemini → OpenRouter
// ============================================================
app.post('/api/generate-textbook', async (req, res) => {
  try {
    const { level, subject, topic } = req.body;
    if (!level || !subject || !topic) {
      return res.status(400).json({ error: 'level, subject and topic are required' });
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

Only return the notes in markdown.`;

    const note = await callAI('gemini', prompt, 90000);
    res.json({ success: true, note });
  } catch (err) {
    console.error('Textbook error:', err.message);
    res.status(500).json({ error: 'Failed to generate textbook: ' + err.message });
  }
});

// ============================================================
// PAST QUESTIONS  →  Groq → OpenRouter
// ============================================================
app.post('/api/generate-past-questions', async (req, res) => {
  try {
    const { exam, year, subject, qtype, count, topic } = req.body;
    if (!exam || !year || !subject) {
      return res.status(400).json({ error: 'exam, year and subject are required' });
    }

    const n = Math.min(parseInt(count) || 10, 20);
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

    const raw = await callAI('groq', prompt, 90000);
    res.json({ success: true, raw });
  } catch (err) {
    console.error('Past questions error:', err.message);
    res.status(500).json({ error: 'Failed to generate questions: ' + err.message });
  }
});

// ============================================================
// THEORY QUESTION  →  Groq → OpenRouter
// ============================================================
app.post('/api/generate-theory-question', async (req, res) => {
  try {
    const { exam, subject } = req.body;
    if (!exam || !subject) {
      return res.status(400).json({ error: 'exam and subject are required' });
    }

    const prompt = `You are a ${exam} examiner in Nigeria.

Generate ONE theory / essay-style question for ${subject}.
Use sub-parts (a), (b), (c) where appropriate, each with mark allocations in brackets like (5 marks).
Do NOT include the answer — only the question.
Keep it realistic for a Nigerian secondary school student.`;

    const question = await callAI('groq', prompt, 60000);
    res.json({ success: true, question });
  } catch (err) {
    console.error('Theory question error:', err.message);
    res.status(500).json({ error: 'Failed to generate theory question: ' + err.message });
  }
});

// ============================================================
// THEORY EXPLANATION  →  Gemini → OpenRouter
// ============================================================
app.post('/api/explain-theory-question', async (req, res) => {
  try {
    const { exam, subject, question } = req.body;
    if (!question) return res.status(400).json({ error: 'question is required' });

    const prompt = `You are a Nigerian secondary school ${subject} teacher.

Provide a complete model answer and explanation for this ${exam} theory question:

${question}

Instructions:
- Address each sub-part (a), (b), (c) separately with clear headings
- Show working / steps where needed
- Explain WHY each step is done, not just what to write
- Give exam tips at the end (## Exam Tips)
- Use markdown formatting

Return the full explanation.`;

    const explanation = await callAI('gemini', prompt, 90000);
    res.json({ success: true, explanation });
  } catch (err) {
    console.error('Theory explanation error:', err.message);
    res.status(500).json({ error: 'Failed to generate explanation: ' + err.message });
  }
});

// ============================================================
// WEB SEARCH  →  SerpAPI  (+ Gemini summary)
// ============================================================
app.post('/api/search', async (req, res) => {
  try {
    const { q } = req.body;
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Query required and must be text' });
    }
    if (!SERPAPI_KEY) {
      return res.status(500).json({ error: 'SerpAPI key not configured' });
    }

    const response = await axios.get('https://serpapi.com/search', {
      params: { q, api_key: SERPAPI_KEY, engine: 'google', num: 5 },
      timeout: 30000
    });

    const results = response.data.organic_results?.slice(0, 5) || [];
    const formatted = results.map(r => ({ title: r.title, snippet: r.snippet, link: r.link }));

    // Optional: add a short AI summary (Gemini → OpenRouter fallback)
    let summary = '';
    try {
      const summaryPrompt = `Summarize these search results about "${q}" in 3-4 sentences for a Nigerian secondary school student:\n\n${formatted.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n')}`;
      summary = await callAI('gemini', summaryPrompt, 30000);
    } catch (e) {
      console.warn('Search summary skipped:', e.message);
    }

    res.json({ success: true, results: formatted, summary });
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
  console.log(`🤖 Gemini:     ${GEMINI_API_KEY ? 'configured' : '❌ MISSING'}`);
  console.log(`⚡ Groq:       ${GROQ_API_KEY ? 'configured' : '❌ MISSING'}`);
  console.log(`🧠 OpenRouter: ${OPENROUTER_API_KEY ? 'configured (fallback)' : '❌ MISSING'}`);
  console.log(`🔍 SerpAPI:    ${SERPAPI_KEY ? 'configured' : '❌ MISSING'}`);
});
