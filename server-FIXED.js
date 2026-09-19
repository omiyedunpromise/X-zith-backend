const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ✅ BETTER CORS - Handle OPTIONS requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Database - Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// API Keys
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

// Health check - TEST CONNECTION
app.get('/', (req, res) => {
  res.json({
    message: '✅ X-ZITH Backend is RUNNING!',
    status: 'ok',
    database: 'Neon PostgreSQL',
    timestamp: new Date()
  });
});

// Password hashing
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// ============================================================
// AUTHENTICATION
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
// AI FEATURES
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    // Using Gemini for chat
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: message }] }]
      }
    );

    const aiResponse = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
    res.json({ success: true, response: aiResponse });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Chat failed: ' + err.message });
  }
});

app.post('/api/generate-textbook', async (req, res) => {
  try {
    const { level, subject, topic } = req.body;
    
    if (!level || !subject || !topic) {
      return res.status(400).json({ error: 'Level, subject, and topic required' });
    }

    const prompt = `Create study notes for ${level} ${subject} - Topic: ${topic}. Make it concise, clear, and easy to understand.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );

    const note = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not generate notes';
    res.json({ success: true, note });
  } catch (err) {
    console.error('Textbook error:', err);
    res.status(500).json({ error: 'Textbook generation failed: ' + err.message });
  }
});

app.post('/api/generate-past-questions', async (req, res) => {
  try {
    const { exam, year, subject, qtype } = req.body;
    
    if (!exam || !year || !subject) {
      return res.status(400).json({ error: 'Exam, year, and subject required' });
    }

    const prompt = `Generate 5 ${qtype} questions for ${exam} ${year} - ${subject}. Format each question as Q1: question text, Options: A) ..., B) ..., C) ..., D) ...`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );

    const questionsText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Parse questions (simplified)
    const questions = [];
    res.json({ success: true, questions, raw: questionsText });
  } catch (err) {
    console.error('Past questions error:', err);
    res.status(500).json({ error: 'Failed: ' + err.message });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const { q } = req.body;
    
    if (!q) {
      return res.status(400).json({ error: 'Query required' });
    }

    // Using SerpAPI
    const response = await axios.get('https://serpapi.com/search', {
      params: {
        q,
        api_key: SERPAPI_KEY,
        engine: 'google'
      }
    });

    res.json({ success: true, results: JSON.stringify(response.data.organic_results?.slice(0, 5)) });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, total_score FROM users ORDER BY total_score DESC LIMIT 10'
    );

    res.json({ success: true, leaderboard: result.rows });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Leaderboard failed: ' + err.message });
  }
});

// ============================================================
// SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ X-ZITH Backend running on port ${PORT}`);
  console.log(`📡 API URL: https://x-zith-backend.onrender.com`);
  console.log(`🗄️  Database: Connected to Neon PostgreSQL`);
});
