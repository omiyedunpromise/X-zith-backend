const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const axios = require('axios');
const bcrypt = require('bcryptjs'); // Fixed for Render
require('dotenv').config();

const app = express();

// --- NUCLEAR CORS FIX ---
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// --- DEBUG TEST ROUTE ---
app.get('/test', (req, res) => {
  res.json({ message: "Backend is alive and CORS is working!" });
});

// --- DATABASE CONNECTION ---
let pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log("✅ Neon Database connected!");
} catch (error) {
  console.error("❌ DB Error:", error.message);
}

// --- AI INITIALIZATION ---
let genAI, deepseekClient, openrouterClient;
try {
  if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  if (process.env.DEEPSEEK_API_KEY) {
    deepseekClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  }
  if (process.env.OPENROUTER_API_KEY) {
    openrouterClient = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
  }
} catch (error) {
  console.error("❌ AI Init Error:", error.message);
}

// --- HELPERS ---
function parseJsonFromAi(text) {
  const match = text.match(/\[.*\]/s);
  if (match) { try { return JSON.parse(match[0]); } catch (e) { return null; } }
  return null;
}

async function generateWithGemini(prompt) {
  if (!genAI) throw new Error("Gemini missing");
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function generateWithOpenRouter(prompt) {
  if (!openrouterClient) throw new Error("OpenRouter missing");
  const completion = await openrouterClient.chat.completions.create({
    model: 'meta-llama/llama-3-8b-instruct:free',
    messages: [{ role: 'user', content: prompt }]
  });
  return completion.choices[0].message.content;
}

async function generateWithDeepseek(prompt) {
  try {
    if (!deepseekClient) throw new Error("DeepSeek missing");
    const completion = await deepseekClient.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }]
    });
    return completion.choices[0].message.content;
  } catch (error) {
    return await generateWithOpenRouter(prompt);
  }
}

// --- ENDPOINTS ---
app.post('/api/register', async (req, res) => {
  const { email, password, username } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  const date = new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, streak, last_active) VALUES ($1, $2, $3, 1, $4) RETURNING id, username, email',
      [username, email, hash, date]
    );
    res.json({ status: 'success', user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ detail: 'User exists or DB error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0 && bcrypt.compareSync(password, result.rows[0].password_hash)) {
      res.json({ status: 'success', user: result.rows[0] });
    } else {
      res.status(401).json({ detail: 'Invalid credentials' });
    }
  } catch (err) {
    res.status(500).json({ detail: 'DB Error' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;
  let response;
  try {
    if (prompt.toLowerCase().includes('what is your name')) response = 'I am Fixto AI! 🤖';
    else if (prompt.toLowerCase().includes('who created')) response = 'Created by Promise Omiyedun (X-ZITH Tech) 💡';
    else {
      try { response = await generateWithGemini(prompt); } 
      catch (e) { response = await generateWithOpenRouter(prompt); }
    }
    res.json({ response });
  } catch (err) {
    res.status(500).json({ detail: 'AI Error' });
  }
});

app.post('/api/textbook', async (req, res) => {
  const { level, subject, topic } = req.body;
  try {
    const note = await generateWithGemini(`Write a textbook note for ${level} ${subject} on '${topic}'.`);
    const quizJson = await generateWithGemini(`Generate 5 MCQs for ${level} ${subject} on '${topic}'. Return ONLY JSON array.`);
    res.json({ note, quiz: parseJsonFromAi(quizJson) });
  } catch (err) {
    res.status(500).json({ detail: 'Gen Error' });
  }
});

app.post('/api/past-questions', async (req, res) => {
  const { exam, year, subject, q_type } = req.body;
  try {
    const qJson = await generateWithDeepseek(`Generate 10 ${q_type} questions for ${exam} ${year} ${subject}. Return ONLY JSON array.`);
    res.json({ questions: parseJsonFromAi(qJson) });
  } catch (err) {
    res.status(500).json({ detail: 'Gen Error' });
  }
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  try {
    const resp = await axios.get('https://serpapi.com/search.json', { params: { q: query, api_key: process.env.SERPAPI_KEY, engine: 'google' } });
    const results = resp.data.organic_results?.slice(0, 5).map(i => `- **${i.title}**: ${i.link}`) || [];
    if (results.length) return res.json({ results: results.join('\n') });
  } catch (err) {}
  const fallback = await generateWithGemini(`Give 5 YouTube search URLs for '${query}'.`);
  res.json({ results: fallback });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
