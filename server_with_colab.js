const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ✅ CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// ============================================================
// IN-MEMORY DATA - LOADED FROM COLAB
// ============================================================

let theoriesData = {};  // Theory content from Colab
let questionsData = {}; // Questions from Colab

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
  res.json({
    message: '✅ X-ZITH Backend is RUNNING!',
    status: 'ok',
    features: ['Theories', 'Questions', 'Generate Answers', 'Chat', 'Search'],
    timestamp: new Date()
  });
});

// ============================================================
// AUTHENTICATION
// ============================================================

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

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
          id: user.id,
          username: user.username,
          email: user.email,
          total_score: user.total_score,
          quizzes_taken: user.quizzes_taken,
          exam_questions: user.exam_questions,
          streak: user.streak
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
// LOAD DATA FROM COLAB
// ============================================================

app.post('/api/load-data', async (req, res) => {
  try {
    const { theories, questions } = req.body;

    if (!theories || !questions) {
      return res.status(400).json({
        error: 'Missing required: theories and questions',
        received: { theoriesPresent: !!theories, questionsPresent: !!questions }
      });
    }

    // Store in memory
    theoriesData = theories;
    questionsData = questions;

    // Log what was loaded
    const theoryCount = Object.values(theories).reduce((acc, exam) => {
      return acc + Object.keys(exam).length;
    }, 0);

    const questionCount = Object.values(questions).reduce((acc, exam) => {
      return acc + Object.values(exam).reduce((s, subj) => s + subj.length, 0);
    }, 0);

    console.log(`✅ Data loaded from Colab:`);
    console.log(`   Theories: ${theoryCount} subjects`);
    console.log(`   Questions: ${questionCount} total`);

    res.json({
      success: true,
      message: 'Data loaded successfully from Colab',
      theoriesLoaded: theoryCount,
      questionsLoaded: questionCount,
      exams: Object.keys(theories)
    });
  } catch (err) {
    console.error('Load data error:', err);
    res.status(500).json({ error: 'Failed to load data: ' + err.message });
  }
});

// ============================================================
// GET AVAILABLE THEORIES AND QUESTIONS
// ============================================================

app.get('/api/available', (req, res) => {
  try {
    const theories = {};
    const questions = {};

    // Get theories structure
    Object.keys(theoriesData).forEach(exam => {
      theories[exam] = Object.keys(theoriesData[exam] || {});
    });

    // Get questions structure
    Object.keys(questionsData).forEach(exam => {
      questions[exam] = {};
      Object.keys(questionsData[exam] || {}).forEach(subject => {
        questions[exam][subject] = questionsData[exam][subject].length;
      });
    });

    res.json({
      success: true,
      theories,
      questions,
      exams: Object.keys(theoriesData)
    });
  } catch (err) {
    console.error('Available error:', err.message);
    res.status(500).json({ error: 'Failed to get available data' });
  }
});

// ============================================================
// GET THEORY FOR AN EXAM/SUBJECT
// ============================================================

app.get('/api/theory/:exam/:subject', (req, res) => {
  try {
    const { exam, subject } = req.params;

    if (!theoriesData[exam] || !theoriesData[exam][subject]) {
      return res.status(404).json({
        error: `Theory not found for ${exam} ${subject}`,
        availableExams: Object.keys(theoriesData),
        availableSubjects: theoriesData[exam] ? Object.keys(theoriesData[exam]) : []
      });
    }

    const theory = theoriesData[exam][subject];

    res.json({
      success: true,
      exam,
      subject,
      theory
    });
  } catch (err) {
    console.error('Get theory error:', err.message);
    res.status(500).json({ error: 'Failed to get theory' });
  }
});

// ============================================================
// GET QUESTIONS FOR AN EXAM/SUBJECT
// ============================================================

app.get('/api/questions/:exam/:subject', (req, res) => {
  try {
    const { exam, subject } = req.params;

    if (!questionsData[exam] || !questionsData[exam][subject]) {
      return res.status(404).json({
        error: `Questions not found for ${exam} ${subject}`,
        availableExams: Object.keys(questionsData),
        availableSubjects: questionsData[exam] ? Object.keys(questionsData[exam]) : []
      });
    }

    const questions = questionsData[exam][subject];

    res.json({
      success: true,
      exam,
      subject,
      totalQuestions: questions.length,
      questions
    });
  } catch (err) {
    console.error('Get questions error:', err.message);
    res.status(500).json({ error: 'Failed to get questions' });
  }
});

// ============================================================
// GENERATE ANSWER FOR A QUESTION (GEMINI)
// ============================================================

app.post('/api/generate-answer', async (req, res) => {
  try {
    const { question, subject, exam } = req.body;

    if (!question) {
      return res.status(400).json({
        error: 'Missing required: question'
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    // Get theory context if available
    let theoryContext = '';
    if (theoriesData[exam] && theoriesData[exam][subject]) {
      theoryContext = `\n\nRelevant Theory:\n${theoriesData[exam][subject]}`;
    }

    // Send question to Gemini for answer
    const prompt = `You are an educational assistant helping Nigerian students prepare for exams.

Question: ${question}
Subject: ${subject}
Exam: ${exam}
${theoryContext}

Provide a clear, detailed answer to this question:
- Answer the question directly
- Explain the concept
- Provide step-by-step solution if needed
- Add important notes or tips
- Keep it suitable for secondary school level

Answer:`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      },
      { timeout: 30000 }
    );

    const answer = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'No answer generated';

    res.json({
      success: true,
      question,
      subject,
      exam,
      answer
    });
  } catch (err) {
    console.error('Generate answer error:', err.message);
    res.status(500).json({ error: 'Failed to generate answer: ' + err.message });
  }
});

// ============================================================
// AI CHAT
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message required and must be text' });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: `You are an AI tutor helping Nigerian students. Answer this question: ${message}`
          }]
        }]
      },
      { timeout: 30000 }
    );

    const aiResponse = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated';
    res.json({ success: true, response: aiResponse });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat failed: ' + err.message });
  }
});

// ============================================================
// WEB SEARCH
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
      params: {
        q,
        api_key: SERPAPI_KEY,
        engine: 'google',
        num: 5
      },
      timeout: 30000
    });

    const results = response.data.organic_results?.slice(0, 5) || [];
    const formattedResults = results.map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link
    }));

    res.json({
      success: true,
      results: formattedResults
    });
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

    res.json({
      success: true,
      leaderboard: result.rows
    });
  } catch (err) {
    console.error('Leaderboard error:', err.message);
    res.status(500).json({ error: 'Leaderboard failed' });
  }
});

// ============================================================
// SERVER START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ X-ZITH Backend running on port ${PORT}`);
  console.log(`📡 API URL: https://x-zith-backend.onrender.com`);
  console.log(`🎓 Features: Theories, Questions, Answers, Chat, Search`);
  console.log(`\n⚠️  Waiting for Colab to send theories and questions...`);
  console.log(`   Send data to: POST /api/load-data`);
});
