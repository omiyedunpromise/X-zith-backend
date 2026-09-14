# X-ZITH Backend - Render Deployment

Serverless backend for X-ZITH Learning Hub built with Express.js and deployed on Render.

## Features

✅ User signup and login
✅ Leaderboard management
✅ Neon PostgreSQL database integration
✅ CORS enabled for frontend
✅ Error handling
✅ FREE deployment on Render

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file:

```
DATABASE_URL=postgresql://user:password@host/database
PORT=3000
NODE_ENV=production
```

Get your DATABASE_URL from Neon!

### 3. Run Locally

```bash
npm start
```

Server runs on `http://localhost:3000`

## API Endpoints

### GET /api
Health check endpoint.

**Response:**
```json
{
  "status": "running",
  "app": "X-ZITH Backend on Render",
  "version": "3.0"
}
```

### POST /api
Handle actions via POST body.

#### Signup
```json
{
  "action": "signup",
  "username": "testuser",
  "email": "test@gmail.com",
  "password": "Test123!"
}
```

#### Login
```json
{
  "action": "login",
  "username": "testuser",
  "password": "Test123!"
}
```

#### Get Leaderboard
```json
{
  "action": "get_leaderboard"
}
```

## Deployment on Render

1. Push code to GitHub
2. Connect GitHub repo to Render
3. Set environment variable: DATABASE_URL
4. Deploy!

## Technologies

- Node.js 18
- Express.js
- PostgreSQL (Neon)
- Render

## Cost

✅ FREE on Render (with limits)

---

Built by Promise Omiyedun | X-ZITH Technology
