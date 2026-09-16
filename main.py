import os
import hashlib
import json
import re
import requests
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import psycopg2
from psycopg2.extras import RealDictCursor
import google.generativeai as genai
from openai import OpenAI

# --- ENVIRONMENT VARIABLES (Set these in Render) ---
DATABASE_URL = os.getenv("DATABASE_URL")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
SERPAPI_KEY = os.getenv("SERPAPI_KEY")

# --- INITIALIZATION ---
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

genai.configure(api_key=GEMINI_API_KEY)
deepseek_client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url="https://api.deepseek.com")
openrouter_client = OpenAI(api_key=OPENROUTER_API_KEY, base_url="https://openrouter.ai/api/v1")

def get_db():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

# --- AI FUNCTIONS ---
def generate_with_gemini(prompt):
    return genai.GenerativeModel('gemini-2.5-flash').generate_content(prompt).text

def generate_with_openrouter(prompt):
    return openrouter_client.chat.completions.create(
        model="meta-llama/llama-3-8b-instruct:free", messages=[{"role": "user", "content": prompt}]
    ).choices[0].message.content

def generate_with_deepseek(prompt):
    try:
        return deepseek_client.chat.completions.create(
            model="deepseek-chat", messages=[{"role": "user", "content": prompt}]
        ).choices[0].message.content
    except Exception:
        return generate_with_openrouter(prompt)

def parse_json_from_ai(text):
    match = re.search(r'\[.*\]', text, re.DOTALL)
    if match:
        try: return json.loads(match.group(0))
        except: return None
    return None

# --- API MODELS ---
class UserAuth(BaseModel):
    email: str
    password: str
    username: str = None

class ChatRequest(BaseModel):
    email: str
    prompt: str

class TextbookRequest(BaseModel):
    email: str
    level: str
    subject: str
    topic: str

class PastQuestionsRequest(BaseModel):
    email: str
    exam: str
    year: str
    subject: str
    q_type: str
    level: int

class SearchRequest(BaseModel):
    query: str

# --- ENDPOINTS ---

@app.post("/api/register")
def register(user: UserAuth):
    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute("INSERT INTO users (username, email, password_hash, streak, last_active) VALUES (%s, %s, %s, 1, %s) RETURNING id, username, email", 
                    (user.username, user.email, hash_password(user.password), datetime.now().strftime("%Y-%m-%d")))
        new_user = cur.fetchone()
        conn.commit()
        return {"status": "success", "user": new_user}
    except Exception as e:
        raise HTTPException(status_code=400, detail="User already exists or database error.")
    finally:
        cur.close(); conn.close()

@app.post("/api/login")
def login(user: UserAuth):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE email=%s AND password_hash=%s", (user.email, hash_password(user.password)))
    db_user = cur.fetchone()
    cur.close(); conn.close()
    if db_user:
        return {"status": "success", "user": db_user}
    raise HTTPException(status_code=401, detail="Invalid credentials")

@app.post("/api/chat")
def chat(req: ChatRequest):
    prompt = req.prompt
    if "what is your name" in prompt.lower():
        response = "I am **Fixto AI**, your personal learning assistant! 🤖"
    elif "who created" in prompt.lower():
        response = "I am created by **Promise Omiyedun**, the CEO and founder of **X-ZITH Technology**. 💡"
    else:
        try:
            response = generate_with_gemini(prompt)
        except:
            response = generate_with_openrouter(prompt)
    return {"response": response}

@app.post("/api/textbook")
def generate_textbook(req: TextbookRequest):
    prompt = f"Act as a teacher for {req.level} students. Write a complete textbook note for {req.subject} on '{req.topic}'. Start from basics. Structure: 1. Intro, 2. Step-by-Step, 3. Key Terms."
    note = generate_with_gemini(prompt)
    
    # Generate Quiz
    quiz_prompt = f"""Generate exactly 5 multiple-choice questions for {req.level} {req.subject} on '{req.topic}'. Return ONLY a valid JSON array. Format: [{{"q": "Question", "options": {{"A": "opt1", "B": "opt2", "C": "opt3", "D": "opt4"}}, "answer": "A", "explanation": "Why"}}]"""
    quiz_json = generate_with_gemini(quiz_prompt)
    quiz = parse_json_from_ai(quiz_json)
    
    return {"note": note, "quiz": quiz}

@app.post("/api/past-questions")
def get_past_questions(req: PastQuestionsRequest):
    prompt = f"""Generate exactly 10 {req.q_type} questions for {req.exam} {req.year} SSS {req.subject}. Return ONLY a valid JSON array. Format: [{{"q": "Question", "options": {{"A": "opt1", "B": "opt2", "C": "opt3", "D": "opt4"}}, "answer": "A", "explanation": "Detailed explanation"}}]"""
    q_json = generate_with_deepseek(prompt)
    questions = parse_json_from_ai(q_json)
    return {"questions": questions}

@app.post("/api/search")
def web_search(req: SearchRequest):
    try:
        response = requests.get("https://serpapi.com/search.json", params={"q": req.query, "api_key": SERPAPI_KEY, "engine": "google"}).json()
        results = [f"- **{item.get('title')}**: {item.get('link')}" for item in response.get("organic_results", [])[:5]]
        if results: return {"results": "\n".join(results)}
    except: pass
    
    # Fallback to AI
    prompt = f"Give me 5 YouTube video search URLs for '{req.query}'. Format as: [Title](https://www.youtube.com/results?search_query=TERM)"
    results = generate_with_gemini(prompt)
    return {"results": results}
