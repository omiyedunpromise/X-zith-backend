const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const axios = require('axios');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();

// --- CORS & MIDDLEWARE ---
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());

// --- ROOT ROUTE (FIXES "NOT FOUND") ---
app.get('/', (req, res) => {
  res.json({ 
    message: "X-ZITH Backend is Running!", 
    status: "ok",
    endpoints: ["/test", "/api/login", "/api/register", "/api/chat", "/api/textbook", "/api/past-questions", "/api/search"]
  });
});

// --- TEST ROUTE ---
app.get('/test', (req, res) => {
  res.json({ message: "Backend is alive and CORS is working!" });
});

// --- DATABASE ---
let pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log("✅ Neon DB Connected");
} catch (e) { console.error("❌ DB Error:", e.message); }

// --- AI ---
let genAI, deepseekClient, openrouterClient;
try {
  if (process.env.GEMINI_API_KEY) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  if (process.env.DEEPSEEK_API_KEY) deepseekClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
  if (process.env.OPENROUTER_API_KEY) openrouterClient = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
} catch (e) { console.error("❌ AI Init Error:", e.message); }

// --- HELPERS ---
function parseJsonFromAi(text) {
  const m = text.match(/\[.*\]/s);
  return m ? (() => { try { return JSON.parse(m[0]); } catch(e) { return null; } })() : null;
}

async function gemini(prompt) {
  if (!genAI) throw new Error("Gemini missing");
  return (await genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }).generateContent(prompt)).response.text();
}

async function openrouter(prompt) {
  if (!openrouterClient) throw new Error("OpenRouter missing");
  return (await openrouterClient.chat.completions.create({ model: 'meta-llama/llama-3-8b-instruct:free', messages: [{ role: 'user', content: prompt }] })).choices[0].message.content;
}

async function deepseek(prompt) {
  try {
    if (!deepseekClient) throw new Error("DeepSeek missing");
    return (await deepseekClient.chat.completions.create({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] })).choices[0].message.content;
  } catch { return await openrouter(prompt); }
}

// --- ENDPOINTS ---
app.post('/api/register', async (req, res) => {
  const { email, password, username } = req.body;
  try {
    const r = await pool.query('INSERT INTO users (username,email,password_hash,streak,last_active) VALUES ($1,$2,$3,1,$4) RETURNING id,username,email', [username, email, bcrypt.hashSync(password,10), new Date().toISOString().split('T')[0]]);
    res.json({ status: 'success', user: r.rows[0] });
  } catch { res.status(400).json({ detail: 'User exists or DB error' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (r.rows.length && bcrypt.compareSync(password, r.rows[0].password_hash)) res.json({ status: 'success', user: r.rows[0] });
    else res.status(401).json({ detail: 'Invalid credentials' });
  } catch { res.status(500).json({ detail: 'DB Error' }); }
});

app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body;
  let resp;
  try {
    if (prompt.toLowerCase().includes('what is your name')) resp = 'I am Fixto AI! 🤖';
    else if (prompt.toLowerCase().includes('who created')) resp = 'Created by Promise Omiyedun (X-ZITH Tech) 💡';
    else { try { resp = await gemini(prompt); } catch { resp = await openrouter(prompt); } }
    res.json({ response: resp });
  } catch { res.status(500).json({ detail: 'AI Error' }); }
});

app.post('/api/textbook', async (req, res) => {
  const { level, subject, topic } = req.body;
  try {
    const note = await gemini(`Write a textbook note for ${level} ${subject} on '${topic}'.`);
    const quiz = await gemini(`Generate 5 MCQs for ${level} ${subject} on '${topic}'. Return ONLY JSON array.`);
    res.json({ note, quiz: parseJsonFromAi(quiz) });
  } catch { res.status(500).json({ detail: 'Gen Error' }); }
});

app.post('/api/past-questions', async (req, res) => {
  const { exam, year, subject, q_type } = req.body;
  try {
    const q = await deepseek(`Generate 10 ${q_type} questions for ${exam} ${year} ${subject}. Return ONLY JSON array.`);
    res.json({ questions: parseJsonFromAi(q) });
  } catch { res.status(500).json({ detail: 'Gen Error' }); }
});

app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  try {
    const r = await axios.get('https://serpapi.com/search.json', { params: { q: query, api_key: process.env.SERPAPI_KEY, engine: 'google' } });
    const results = r.data.organic_results?.slice(0,5).map(i => `- **${i.title}**: ${i.link}`) || [];
    if (results.length) return res.json({ results: results.join('\n') });
  } catch {}
  const fb = await gemini(`Give 5 YouTube search URLs for '${query}'.`);
  res.json({ results: fb });
});

// --- START ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
