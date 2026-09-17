const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const axios = require('axios');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- AI INITIALIZATION ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const deepseekClient = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com'
});
const openrouterClient = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

// --- HELPER FUNCTIONS ---
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function checkPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function parseJsonFromAi(text) {
  const match = text.match(/\[.*\]/s);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      return null;
    }
  }
  return null;
}

// --- AI FUNCTIONS ---
async function generateWithGemini(prompt) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function generateWithOpenRouter(prompt) {
  const completion = await openrouterClient.chat.completions.create({
    model: 'meta-llama/llama-3-8b-instruct:free',
    messages: [{ role: 'user', content: prompt }]
  });
  return completion.choices[0].message.content;
}

async function generateWithDeepseek(prompt) {
  try {
    const completion = await deepseekClient.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }]
    });
    return completion.choices[0].message.content;
  } catch (error) {
    return await generateWithOpenRouter(prompt);
  }
}

// --- API ENDPOINTS ---

// Register User
app.post('/api/register', async (req, res) => {
  const { email, password, username } = req.body;
  const passwordHash = hashPassword(password);
  const lastActive = new Date().toISOString().split('T')[0];
  
  try {
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, streak, last_active) VALUES ($1, $2, $3, 1, $4) RETURNING id, username, email',
      [username, email, passwordHash, lastActive]
    );
    res.json({ status: 'success', user: result.rows[0] });
  } catch (error) {
    res.status(400).json({ detail: 'User already exists or database error' });
  }
});

// Login User
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (result.rows.length > 0 && checkPassword(password, result.rows[0].password_hash)) {
      res.json({ status: 'success', user: result.rows[0] });
    } else {
      res.status(401).json({ detail: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ detail: 'Database error' });
  }
});

// AI Chat
app.post('/api/chat', async (req, res) => {
  const { email, prompt } = req.body;
  let response;
  
  if (prompt.toLowerCase().includes('what is your name')) {
    response = 'I am **Fixto AI**, your personal learning assistant! 🤖';
  } else if (prompt.toLowerCase().includes('who created')) {
    response = 'I am created by **Promise Omiyedun**, the CEO and founder of **X-ZITH Technology**. 💡';
  } else {
    try {
      response = await generateWithGemini(prompt);
    } catch (error) {
      response = await generateWithOpenRouter(prompt);
    }
  }
  
  res.json({ response });
});

// Generate Textbook
app.post('/api/textbook', async (req, res) => {
  const { email, level, subject, topic } = req.body;
  
  const notePrompt = `Act as a teacher for ${level} students. Write a complete textbook note for ${subject} on '${topic}'. Start from basics. Structure: 1. Intro, 2. Step-by-Step, 3. Key Terms.`;
  const note = await generateWithGemini(notePrompt);
  
  const quizPrompt = `Generate exactly 5 multiple-choice questions for ${level} ${subject} on '${topic}'. Return ONLY a valid JSON array. Format: [{"q": "Question", "options": {"A": "opt1", "B": "opt2", "C": "opt3", "D": "opt4"}, "answer": "A", "explanation": "Why"}]`;
  const quizJson = await generateWithGemini(quizPrompt);
  const quiz = parseJsonFromAi(quizJson);
  
  res.json({ note, quiz });
});

// Past Questions
app.post('/api/past-questions', async (req, res) => {
  const { email, exam, year, subject, q_type, level } = req.body;
  
  const prompt = `Generate exactly 10 ${q_type} questions for ${exam} ${year} SSS ${subject}. Return ONLY a valid JSON array. Format: [{"q": "Question", "options": {"A": "opt1", "B": "opt2", "C": "opt3", "D": "opt4"}, "answer": "A", "explanation": "Detailed explanation"}]`;
  
  const qJson = await generateWithDeepseek(prompt);
  const questions = parseJsonFromAi(qJson);
  
  res.json({ questions });
});

// Web Search
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  
  try {
    const response = await axios.get('https://serpapi.com/search.json', {
      params: {
        q: query,
        api_key: process.env.SERPAPI_KEY,
        engine: 'google'
      }
    });
    
    const results = response.data.organic_results?.slice(0, 5).map(item => 
      `- **${item.title}**: ${item.link}`
    ) || [];
    
    if (results.length > 0) {
      return res.json({ results: results.join('\n') });
    }
  } catch (error) {
    console.error('SerpAPI error:', error);
  }
  
  // Fallback to AI
  const prompt = `Give me 5 YouTube video search URLs for '${query}'. Format as: [Title](https://www.youtube.com/results?search_query=TERM)`;
  const results = await generateWithGemini(prompt);
  
  res.json({ results });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
