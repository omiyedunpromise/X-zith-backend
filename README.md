# X-ZITH Backend for Vercel

This is the backend API for X-ZITH Learning Hub running on Vercel serverless functions.

## 📁 Structure

```
vercel-backend/
├── api/
│   └── index.py         (Main API handler)
├── requirements.txt     (Python dependencies)
├── vercel.json         (Vercel configuration)
└── README.md          (This file)
```

## 🚀 Deployment Steps

### Step 1: Create Vercel Account
1. Go to: https://vercel.com
2. Sign up (connect with GitHub recommended)

### Step 2: Create GitHub Repository
1. Create new repo on GitHub: `x-zith-backend`
2. Add these files:
   - api/index.py
   - requirements.txt
   - vercel.json

### Step 3: Deploy on Vercel
1. Go to Vercel Dashboard
2. Click "Add New" → "Project"
3. Select your GitHub repo
4. Click "Import"
5. No build command needed (auto-detected)
6. Click "Deploy"

### Step 4: Set Environment Variables
1. After deployment, go to Project Settings
2. Go to "Environment Variables"
3. Add these 5 variables:
   - `DATABASE_URL`: Your Neon connection string
   - `GEMINI_API_KEY`: Google Gemini API key
   - `DEEPSEEK_API_KEY`: DeepSeek API key
   - `OPENROUTER_API_KEY`: OpenRouter API key
   - `SERPAPI_KEY`: SerpAPI key (optional)
4. Redeploy after adding secrets

### Step 5: Get Your Backend URL
After deployment, Vercel shows your URL:
```
https://x-zith-backend.vercel.app/api
```

## 🔌 API Endpoints

All endpoints are POST requests to `/api` with this format:

### Signup
```json
{
  "action": "signup",
  "username": "john123",
  "email": "john@gmail.com",
  "password": "Test123!"
}
```

### Login
```json
{
  "action": "login",
  "username": "john123",
  "password": "Test123!"
}
```

### Get Leaderboard
```json
{
  "action": "get_leaderboard"
}
```

### Get Badges
```json
{
  "action": "get_badges",
  "username": "john123"
}
```

### Get Past Questions
```json
{
  "action": "get_past_questions",
  "exam_type": "WAEC",
  "subject": "English",
  "limit": 10
}
```

### Get Textbooks
```json
{
  "action": "get_textbooks",
  "subject": "Mathematics",
  "limit": 10
}
```

### Update Score
```json
{
  "action": "update_score",
  "username": "john123",
  "points": 10,
  "type": "Quiz",
  "details": "Completed Math Quiz"
}
```

## 🔐 Environment Variables

### DATABASE_URL
Your Neon PostgreSQL connection string:
```
postgresql://neondb_owner:npg_...@ep-...
```

### GEMINI_API_KEY
Google Gemini API key from: https://makersuite.google.com/app/apikey

### DEEPSEEK_API_KEY
DeepSeek API key from: https://platform.deepseek.com

### OPENROUTER_API_KEY
OpenRouter key from: https://openrouter.ai/keys

### SERPAPI_KEY (Optional)
SerpAPI key from: https://serpapi.com

## 📊 Testing

### Test 1: Check Status
```bash
curl https://x-zith-backend.vercel.app/api
```

### Test 2: Signup
```bash
curl -X POST https://x-zith-backend.vercel.app/api \
  -H "Content-Type: application/json" \
  -d '{
    "action": "signup",
    "username": "testuser",
    "email": "test@gmail.com",
    "password": "Test123!"
  }'
```

### Test 3: Login
```bash
curl -X POST https://x-zith-backend.vercel.app/api \
  -H "Content-Type: application/json" \
  -d '{
    "action": "login",
    "username": "testuser",
    "password": "Test123!"
  }'
```

## 🆘 Troubleshooting

### "Database error" response
- Check DATABASE_URL is set in Vercel Environment Variables
- Verify connection string is complete (no spaces)
- Test connection in Neon console

### "Module not found: psycopg2"
- Vercel should auto-install from requirements.txt
- If not, try redeploying after updating requirements.txt

### 502 Gateway Error
- Check Vercel logs
- Ensure all environment variables are set
- Verify database connection works

## 📝 Notes

- All requests must be POST
- Request body must be JSON
- Database schema must be created first (see 01-NEON-DATABASE-SCHEMA.sql)
- CORS headers are included in responses
- Maximum 50 seconds per request (Vercel limit)

## 🎯 Frontend Integration

Your frontend should use this URL:
```javascript
const API_URL = "https://x-zith-backend.vercel.app/api";
```

Update in: `05-GITHUB-FRONTEND.html`

Replace:
```javascript
const API_URL = "https://X-zith123-x-zith-api.hf.space/api";
```

With:
```javascript
const API_URL = "https://x-zith-backend.vercel.app/api";
```

## 📞 Support

For issues:
1. Check Vercel logs: Project → Deployments → Logs
2. Check environment variables are set
3. Test database connection separately
4. See troubleshooting guide

---

Good luck! 🚀
