const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
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
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SERPAPI_KEY        = process.env.SERPAPI_KEY;

const GEMINI_MODEL       = 'gemini-2.0-flash';                             // Google
const OPENROUTER_MODEL   = 'deepseek/deepseek-chat';                       // OpenRouter model id
// Other options: 'meta-llama/llama-3.1-70b-instruct', 'openai/gpt-4o-mini',
//                'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'

let theoriesData = {};
let questionsData = {};

// ============================================================
// HELPERS
// ============================================================
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// --- Gemini (used for: textbook, chat) ---
async function callGemini(prompt, timeout = 60000) {
  if (!GEMINI_API_KEY) throw new Error('Gemini API key not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const response = await axios.post(
    url,
    { contents: [{ parts: [{ text: prompt }] }] },
    { timeout }
  );
  return response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// --- OpenRouter (used for: past questions, theory Q, theory explanation) ---
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
  return response.data.choices?.[0]?.message?.content || '';
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    message: '✅ X-ZITH Backend is RUNNING!',
    status: 'ok',
    ai: {
      gemini: !!GEMINI_API_KEY,
      openrouter: !!OPENROUTER_API_KEY,
      serpapi: !!SERPAPI_KEY
    },
    routes: [
      'POST /api/signup', 'POST /api/login',
      'POST /api/chat (Gemini)',
      'POST /api/generate-textbook (Gemini)',
      'POST /api/generate-past-questions (OpenRouter)',
      'POST /api/generate-theory-question (OpenRouter)',
      'POST /api/explain-theory-question (OpenRouter)',
      'POST /api/search (SerpAPI)',
      'GET  /api/leaderboard'
    ],
    timestamp: new Date()
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
// COLAB DATA (optional – keep if you still load from Colab)
// ============================================================
app.post('/api/load-data', async (req, res) => {
  try {
    const { theories, questions } = req.body;
    if (!theories || !questions) {
      return res.status(400).json({ error: 'Missing required: theories and questions' });
    }
    theoriesData = theories;
    questionsData = questions;
    res.json({ success: true, message: 'Data loaded successfully from Colab' });
  } catch (err) {
    console.error('Load data error:', err);
    res.status(500).json({ error: 'Failed to load data: ' + err.message });
  }
});

app.get('/api/available', (req, res) => {
  try {
    const theories = {};
    const questions = {};
    Object.keys(theoriesData).forEach(exam => {
      theories[exam] = Object.keys(theoriesData[exam] || {});
    });
    Object.keys(questionsData).forEach(exam => {
      questions[exam] = {};
      Object.keys(questionsData[exam] || {}).forEach(subject => {
        questions[exam][subject] = questionsData[exam][subject].length;
      });
    });
    res.json({ success: true, theories, questions, exams: Object.keys(theoriesData) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get available data' });
  }
});

app.get('/api/theory/:exam/:subject', (req, res) => {
  const { exam, subject } = req.params;
  if (!theoriesData[exam] || !theoriesData[exam][subject]) {
    return res.status(404).json({ error: `Theory not found for ${exam} ${subject}` });
  }
  res.json({ success: true, exam, subject, theory: theoriesData[exam][subject] });
});

app.get('/api/questions/:exam/:subject', (req, res) => {
  const { exam, subject } = req.params;
  if (!questionsData[exam] || !questionsData[exam][subject]) {
    return res.status(404).json({ error: `Questions not found for ${exam} ${subject}` });
  }
  res.json({
    success: true, exam, subject,
    totalQuestions: questionsData[exam][subject].length,
    questions: questionsData[exam][subject]
  });
});

// ============================================================
// GENERATE ANSWER (Gemini)
// ============================================================
app.post('/api/generate-answer', async (req, res) => {
  try {
    const { question, subject, exam } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing required: question' });

    const prompt = `You are an educational assistant helping Nigerian students prepare for exams.

Question: ${question}
Subject: ${subject}
Exam: ${exam}

Provide a clear, detailed answer with step-by-step solution and exam tips.`;
    const answer = await callGemini(prompt, 30000);
    res.json({ success: true, question, subject, exam, answer });
  } catch (err) {
    console.error('Generate answer error:', err.message);
    res.status(500).json({ error: 'Failed to generate answer: ' + err.message });
  }
});

// ============================================================
// AI CHAT  →  GEMINI
// ============================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message required and must be text' });
    }

    const prompt = `You are an AI tutor helping Nigerian secondary school students prepare for WAEC, NECO and JAMB. Answer clearly and use markdown formatting (headings, bullet points, bold for key terms). Question: ${message}`;
    const aiResponse = await callGemini(prompt, 60000);

    res.json({ success: true, response: aiResponse || 'No response generated' });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat failed: ' + err.message });
  }
});

// ============================================================
// WEB SEARCH  →  SERPAPI
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
    res.json({ success: true, results: formatted });
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
// TEXTBOOK GENERATOR  →  GEMINI
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

    const note = await callGemini(prompt, 90000);
    if (!note) return res.status(500).json({ error: 'No content generated' });

    res.json({ success: true, note });
  } catch (err) {
    console.error('Textbook error:', err.message);
    res.status(500).json({ error: 'Failed to generate textbook: ' + err.message });
  }
});

// ============================================================
// PAST QUESTIONS GENERATOR  →  OPENROUTER
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

    const raw = await callOpenRouter(prompt, 90000);
    if (!raw) return res.status(500).json({ error: 'No questions generated' });

    res.json({ success: true, raw });
  } catch (err) {
    console.error('Past questions error:', err.message);
    res.status(500).json({ error: 'Failed to generate questions: ' + err.message });
  }
});

// ============================================================
// THEORY QUESTION  →  OPENROUTER
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

    const question = await callOpenRouter(prompt, 60000);
    if (!question) return res.status(500).json({ error: 'No question generated' });

    res.json({ success: true, question });
  } catch (err) {
    console.error('Theory question error:', err.message);
    res.status(500).json({ error: 'Failed to generate theory question: ' + err.message });
  }
});

// ============================================================
// THEORY EXPLANATION  →  OPENROUTER
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

    const explanation = await callOpenRouter(prompt, 90000);
    if (!explanation) return res.status(500).json({ error: 'No explanation generated' });

    res.json({ success: true, explanation });
  } catch (err) {
    console.error('Theory explanation error:', err.message);
    res.status(500).json({ error: 'Failed to generate explanation: ' + err.message });
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
  console.log(`🤖 Gemini:     ${GEMINI_API_KEY ? 'configured' : '❌ MISSING'}`);
  console.log(`🧠 OpenRouter: ${OPENROUTER_API_KEY ? 'configured' : '❌ MISSING'}`);
  console.log(`🔍 SerpAPI:    ${SERPAPI_KEY ? 'configured' : '❌ MISSING'}`);
});