const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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

// Helper functions
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

    try {
      await pool.query(
        'INSERT INTO users (username, email, password_hash, total_score, quizzes_taken, exam_questions, streak, last_active, last_daily_challenge) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [username, email, passwordHash, 0, 0, 0, 1, today, null]
      );

      res.json({ success: true, message: 'Account created! Please login.' });
    } catch (err) {
      if (err.code === '23505') {
        res.status(400).json({ success: false, error: 'Username or email already exists' });
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
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
      res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

app.get('/api/user/:email', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [req.params.email]
    );

    if (result.rows.length > 0) {
      res.json({ success: true, user: result.rows[0] });
    } else {
      res.status(404).json({ success: false, error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ============================================================
// AI FUNCTIONS
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    // Special responses
    if (message.toLowerCase().includes('what is your name')) {
      return res.json({ response: 'I am **Fixto AI**, your personal learning assistant! 🤖' });
    }

    if (message.toLowerCase().includes('who created')) {
      return res.json({ response: 'I am created by **Promise Omiyedun**, CEO and founder of **X-ZITH Technology**. 💡' });
    }

    // Use Gemini for general chat
    try {
      const response = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        {
          contents: [{
            parts: [{ text: message }]
          }]
        },
        {
          params: { key: GEMINI_API_KEY },
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const reply = response.data.candidates[0].content.parts[0].text;
      res.json({ response: reply });
    } catch (err) {
      console.error('Gemini error, trying OpenRouter:', err.message);
      
      // Fallback to OpenRouter
      const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'meta-llama/llama-3-8b-instruct:free',
          messages: [{ role: 'user', content: message }]
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const reply = response.data.choices[0].message.content;
      res.json({ response: reply });
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Failed to generate response' });
  }
});

app.post('/api/generate-textbook', async (req, res) => {
  try {
    const { level, subject, topic } = req.body;

    const prompt = `Act as a teacher for ${level} students. Write a complete textbook note for ${subject} on '${topic}'. 
    Structure: 
    1. Introduction
    2. Step-by-Step Explanation
    3. Key Terms and Definitions
    4. Important Points
    5. Summary`;

    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        contents: [{
          parts: [{ text: prompt }]
        }]
      },
      {
        params: { key: GEMINI_API_KEY },
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const note = response.data.candidates[0].content.parts[0].text;
    res.json({ note });
  } catch (err) {
    console.error('Textbook generation error:', err);
    res.status(500).json({ error: 'Failed to generate textbook' });
  }
});

app.post('/api/generate-quiz', async (req, res) => {
  try {
    const { level, subject, topic, count } = req.body;

    const prompt = `Generate exactly ${count} multiple-choice questions for ${level} ${subject} on '${topic}'. 
    Return ONLY a valid JSON array. No markdown. 
    Format: [{"q": "Question text", "options": {"A": "opt1", "B": "opt2", "C": "opt3", "D": "opt4"}, "answer": "A", "explanation": "Why"}]`;

    const response = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        contents: [{
          parts: [{ text: prompt }]
        }]
      },
      {
        params: { key: GEMINI_API_KEY },
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    const jsonMatch = text.match(/\[.*\]/s);
    const questions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    res.json({ questions });
  } catch (err) {
    console.error('Quiz generation error:', err);
    res.status(500).json({ error: 'Failed to generate quiz' });
  }
});

app.post('/api/generate-past-questions', async (req, res) => {
  try {
    const { exam, year, level, subject, qtype, count } = req.body;

    const prompt = `Generate exactly ${count} ${qtype} questions for ${exam} ${year} ${level} ${subject}. 
    Return ONLY a valid JSON array. No markdown.
    Format: [{"q": "Question text", "options": {"A": "opt1", "B": "opt2", "C": "opt3", "D": "opt4"}, "answer": "A", "explanation": "Detailed explanation"}]`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\[.*\]/s);
    const questions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    res.json({ questions });
  } catch (err) {
    console.error('Past questions error, trying fallback:', err.message);

    // Fallback to OpenRouter
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'meta-llama/llama-3-8b-instruct:free',
        messages: [{
          role: 'user',
          content: `Generate exactly ${count} multiple-choice questions for ${exam} ${year} ${level} ${subject}.
          Return ONLY JSON array like [{"q": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}, "answer": "A", "explanation": "..."}]`
        }]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const text = response.data.choices[0].message.content;
    const jsonMatch = text.match(/\[.*\]/s);
    const questions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    res.json({ questions });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;

    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        q,
        api_key: SERPAPI_KEY,
        engine: 'google'
      }
    });

    const results = response.data.organic_results?.slice(0, 5).map(item => ({
      title: item.title,
      link: item.link
    })) || [];

    res.json({ results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================================
// SCORING & ACTIVITY
// ============================================================

app.post('/api/update-score', async (req, res) => {
  try {
    const { email, points, activityType, details } = req.body;

    // Get current user
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const today = new Date().toISOString().split('T')[0];

    // Update score
    const newScore = user.total_score + points;
    const newQuizzes = user.quizzes_taken + (activityType === 'Quiz' ? 1 : 0);
    const newExams = user.exam_questions + (['WAEC', 'NECO', 'JAMB', 'Daily Challenge'].includes(activityType) ? 1 : 0);

    await pool.query(
      'UPDATE users SET total_score = $1, quizzes_taken = $2, exam_questions = $3 WHERE email = $4',
      [newScore, newQuizzes, newExams, email]
    );

    // Log activity
    await pool.query(
      'INSERT INTO activity (username, type, details, points, timestamp) VALUES ($1, $2, $3, $4, $5)',
      [email, activityType, details, points, new Date().toISOString()]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Score update error:', err);
    res.status(500).json({ error: 'Failed to update score' });
  }
});

// ============================================================
// LEADERBOARD
// ============================================================

app.get('/api/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT username, total_score FROM users ORDER BY total_score DESC LIMIT 10'
    );

    res.json({ leaderboard: result.rows });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api', (req, res) => {
  res.json({
    status: 'running',
    app: 'X-ZITH Backend',
    version: '3.0',
    features: ['Chat', 'Textbooks', 'Quizzes', 'Past Questions', 'Web Search']
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ X-ZITH Backend running on port ${PORT}`);
});
