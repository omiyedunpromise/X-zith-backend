# X-ZITH Backend - Node.js

Serverless backend for X-ZITH Learning Hub built with Node.js and deployed on Vercel.

## Features

- ✅ Signup / Login
- ✅ Leaderboard
- ✅ Database integration (Neon PostgreSQL)
- ✅ CORS enabled
- ✅ Serverless on Vercel
- ✅ Health check endpoint

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create `.env` file with:

```
DATABASE_URL=postgresql://user:password@host/database
```

### 3. Deploy to Vercel

```bash
vercel deploy
```

## API Endpoints

### GET /api

Health check endpoint.

**Response:**
```json
{
  "status": "running",
  "app": "X-ZITH Backend on Vercel",
  "version": "3.0",
  "timestamp": "2026-09-13T..."
}
```

### POST /api

Handle actions via POST body:

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

## Database

Uses Neon PostgreSQL with 11 tables:
- users
- leaderboard
- badges
- and more...

## Development

```bash
npm run dev
```

## Built With

- Node.js 18
- pg (PostgreSQL client)
- Vercel Serverless

---

Built by Promise Omiyedun | X-ZITH Technology
