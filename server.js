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

// ============================================================
// LOAD THEORIES & EXAMPLES FROM COLAB/DATABASE
// ============================================================

// In-memory cache (you'll load this from Colab files)
let theoriesData = {};
let questionsExamples = {};

// TODO: You'll populate these from Colab
function loadTheoriesFromColab(data) {
  theoriesData = data;
}

function loadQuestionsExamplesFromColab(data) {
  questionsExamples = data;
}

// Health check - TEST CONNECTION
app.get('/', (req, res) => {
  res.json({
    message: '✅ X-ZITH Backend is RUNNING!',
    status: 'ok',
    database: 'Neon PostgreSQL',
    ai_engines: ['Gemini', 'Deepseek'],
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

// 1️⃣ AI CHAT (Using Gemini)
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
    res.json({ success: true, response: aiResponse, message: aiResponse });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat failed: ' + err.message });
  }
});

// 2️⃣ GENERATE TEXTBOOK (Using Gemini)
app.post('/api/generate-textbook', async (req, res) => {
  try {
    const { exam, year, subject, topic } = req.body;
    
    // Accept both old (level) and new (exam) parameter names
    const level = req.body.level || exam;
    
    if (!level || !subject || !topic) {
      return res.status(400).json({ 
        error: 'Missing parameters. Required: level/exam, subject, topic',
        received: { level, subject, topic }
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const prompt = `Create comprehensive study notes for ${level} ${subject} - Topic: "${topic}".
    
Format:
- Start with a clear heading
- Include key concepts and definitions
- Add examples relevant to Nigerian curriculum
- Include formulas if applicable
- Add practice tips
- Keep it concise but thorough
- Make it suitable for exam preparation`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      { timeout: 30000 }
    );

    const note = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not generate notes';
    res.json({ success: true, note, response: note });
  } catch (err) {
    console.error('Textbook error:', err.message);
    res.status(500).json({ error: 'Textbook generation failed: ' + err.message });
  }
});

// 3️⃣ GENERATE PAST QUESTIONS (Using Deepseek)
app.post('/api/generate-past-questions', async (req, res) => {
  try {
    const { exam, year, subject, qtype, count = 10, topic } = req.body;
    
    if (!exam || !year || !subject) {
      return res.status(400).json({ 
        error: 'Missing required parameters: exam, year, subject',
        received: { exam, year, subject }
      });
    }

    if (!DEEPSEEK_API_KEY) {
      return res.status(500).json({ error: 'Deepseek API key not configured' });
    }

    // Get examples from loaded data (or provide context)
    const examples = questionsExamples[exam]?.[subject] || '';
    const topicFilter = topic ? `Focus on topic: ${topic}. ` : '';

    const prompt = `You are generating past exam questions for Nigerian students.

Exam: ${exam} ${year}
Subject: ${subject}
Type: ${qtype}
Count: ${count}
${topicFilter}

${examples ? `Reference examples:\n${examples}\n` : ''}

Generate ${count} ${qtype} questions in this EXACT format:

Q1: [Question text]
Options: 
A) [Option A]
B) [Option B]
C) [Option C]
D) [Option D]
CorrectAnswer: [A/B/C/D]
Explanation: [Why this answer is correct]

Q2: [Next question...]
...and so on

IMPORTANT:
- Make questions realistic and exam-standard
- Include varied difficulty levels
- Ensure explanations are educational
- Follow Nigerian curriculum standards`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 3000
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const questionsText = response.data.choices?.[0]?.message?.content || '';
    
    res.json({ 
      success: true, 
      questions: parseQuestions(questionsText),
      raw: questionsText,
      response: questionsText
    });
  } catch (err) {
    console.error('Past questions error:', err.message);
    res.status(500).json({ error: 'Failed to generate questions: ' + err.message });
  }
});

// 4️⃣ CHECK ANSWER & GET CORRECTION (Using Gemini)
app.post('/api/check-answer', async (req, res) => {
  try {
    const { question, userAnswer, correctAnswer, subject, exam } = req.body;
    
    if (!question || !userAnswer || !correctAnswer) {
      return res.status(400).json({ 
        error: 'Missing required: question, userAnswer, correctAnswer'
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const isCorrect = userAnswer.toLowerCase().trim() === correctAnswer.toLowerCase().trim();

    const prompt = `You are an exam evaluator for Nigerian students.

Question: ${question}
Subject: ${subject || 'General'}
Exam: ${exam || 'General'}

Student's Answer: ${userAnswer}
Correct Answer: ${correctAnswer}

Provide evaluation in this format:

STATUS: [CORRECT/INCORRECT]

EXPLANATION: [Clear explanation of the correct answer - 2-3 sentences]

WHY: ${isCorrect ? '[Additional insight or related concept]' : '[Why the student answer was wrong and how to correct thinking]'}

LEARNING_TIP: [One practical tip to remember this concept]`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      { timeout: 30000 }
    );

    const correction = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'No feedback';
    
    res.json({ 
      success: true, 
      isCorrect,
      userAnswer,
      correctAnswer,
      correction,
      response: correction
    });
  } catch (err) {
    console.error('Check answer error:', err.message);
    res.status(500).json({ error: 'Failed to evaluate answer: ' + err.message });
  }
});

// 5️⃣ GENERATE THEORY (Using stored data from Colab)
app.post('/api/generate-theory', async (req, res) => {
  try {
    const { exam, subject } = req.body;
    
    if (!exam || !subject) {
      return res.status(400).json({ 
        error: 'Missing required: exam, subject',
        received: { exam, subject }
      });
    }

    // Get theory from loaded data
    const theory = theoriesData[exam]?.[subject];

    if (!theory) {
      return res.status(404).json({ 
        error: `Theory not found for ${exam} ${subject}`,
        availableExams: Object.keys(theoriesData),
        availableSubjects: theoriesData[exam] ? Object.keys(theoriesData[exam]) : []
      });
    }

    res.json({ 
      success: true, 
      theory,
      exam,
      subject,
      response: theory
    });
  } catch (err) {
    console.error('Generate theory error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve theory: ' + err.message });
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
      results: formattedResults,
      items: formattedResults
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
    res.status(500).json({ error: 'Leaderboard failed: ' + err.message });
  }
});

// ============================================================
// LOAD DATA ENDPOINT (for Colab to send data)
// ============================================================

app.post('/api/load-data', async (req, res) => {
  try {
    const { theories, examples } = req.body;

    if (theories) {
      loadTheoriesFromColab(theories);
      console.log('✅ Theories loaded from Colab');
    }

    if (examples) {
      loadQuestionsExamplesFromColab(examples);
      console.log('✅ Question examples loaded from Colab');
    }

    res.json({ 
      success: true, 
      message: 'Data loaded successfully',
      theoriesLoaded: !!theories,
      examplesLoaded: !!examples
    });
  } catch (err) {
    console.error('Load data error:', err.message);
    res.status(500).json({ error: 'Failed to load data: ' + err.message });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function parseQuestions(text) {
  // Parse Deepseek response into structured format
  const questions = [];
  const questionBlocks = text.split(/Q\d+:/);
  
  questionBlocks.forEach((block, index) => {
    if (index === 0 || !block.trim()) return;
    
    const lines = block.trim().split('\n');
    const questionText = lines[0];
    const optionsMatch = block.match(/Options?:?\s*([\s\S]*?)(?=CorrectAnswer:|$)/i);
    const correctMatch = block.match(/CorrectAnswer:\s*([A-D])/i);
    const explanationMatch = block.match(/Explanation:\s*([\s\S]*?)(?=Q\d+:|$)/i);

    if (questionText && correctMatch) {
      questions.push({
        question: questionText,
        options: optionsMatch ? optionsMatch[1].trim() : '',
        correctAnswer: correctMatch[1],
        explanation: explanationMatch ? explanationMatch[1].trim() : 'No explanation provided'
      });
    }
  });

  return questions;
}

// ============================================================
// SERVER START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ X-ZITH Backend running on port ${PORT}`);
  console.log(`📡 API URL: https://x-zith-backend.onrender.com`);
  console.log(`🗄️  Database: Connected to Neon PostgreSQL`);
  console.log(`🤖 AI Engines: Gemini (chat, textbook, corrections), Deepseek (questions)`);
  console.log(`\n⚠️  IMPORTANT: Load data from Colab using POST /api/load-data`);
});
