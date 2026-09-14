const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(express.json());

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Helper functions
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Routes

// Health check
app.get('/api', (req, res) => {
  res.json({
    status: 'running',
    app: 'X-ZITH Backend on Render',
    version: '3.0',
    timestamp: new Date().toISOString()
  });
});

// Main API endpoint
app.post('/api', async (req, res) => {
  try {
    const { action, username, email, password } = req.body;

    // SIGNUP
    if (action === 'signup') {
      if (!username || !email || !password) {
        return res.status(400).json({ 
          success: false, 
          error: 'All fields required' 
        });
      }

      if (password.length < 6) {
        return res.status(400).json({ 
          success: false, 
          error: 'Password must be 6+ characters' 
        });
      }

      const passwordHash = hashPassword(password);

      try {
        // Check username exists
        const userCheck = await pool.query(
          'SELECT id FROM users WHERE username = $1',
          [username]
        );
        if (userCheck.rows.length > 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'Username already taken' 
          });
        }

        // Check email exists
        const emailCheck = await pool.query(
          'SELECT id FROM users WHERE email = $1',
          [email]
        );
        if (emailCheck.rows.length > 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'Email already registered' 
          });
        }

        // Insert user
        await pool.query(
          'INSERT INTO users (username, email, password_hash, badges_earned, unseen_badges) VALUES ($1, $2, $3, $4, $5)',
          [username, email, passwordHash, '1', '1']
        );

        // Add to leaderboard
        await pool.query(
          'INSERT INTO leaderboard (username, total_score, streak, quizzes_completed, questions_answered, badges_count) VALUES ($1, $2, $3, $4, $5, $6)',
          [username, 0, 1, 0, 0, 1]
        );

        return res.json({ 
          success: true, 
          message: 'Account created! Please login.' 
        });
      } catch (err) {
        console.error('Signup error:', err);
        return res.status(500).json({ 
          error: 'Database error: ' + err.message 
        });
      }
    }

    // LOGIN
    if (action === 'login') {
      if (!username || !password) {
        return res.status(400).json({ 
          success: false, 
          error: 'Username and password required' 
        });
      }

      const passwordHash = hashPassword(password);

      try {
        const result = await pool.query(
          'SELECT id, username, email FROM users WHERE username = $1 AND password_hash = $2',
          [username, passwordHash]
        );

        if (result.rows.length > 0) {
          return res.json({
            success: true,
            message: 'Login successful',
            user: result.rows[0]
          });
        } else {
          return res.status(401).json({ 
            success: false, 
            error: 'Invalid credentials' 
          });
        }
      } catch (err) {
        console.error('Login error:', err);
        return res.status(500).json({ 
          error: 'Database error: ' + err.message 
        });
      }
    }

    // GET LEADERBOARD
    if (action === 'get_leaderboard') {
      try {
        const result = await pool.query(
          'SELECT * FROM leaderboard ORDER BY total_score DESC LIMIT 100'
        );
        return res.json({ 
          success: true, 
          leaderboard: result.rows 
        });
      } catch (err) {
        console.error('Leaderboard error:', err);
        return res.status(500).json({ 
          error: 'Database error: ' + err.message 
        });
      }
    }

    // Unknown action
    return res.status(400).json({ 
      error: 'Unknown action: ' + action 
    });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ 
      error: 'Server error: ' + err.message 
    });
  }
});

// Preflight
app.options('/api', (req, res) => {
  res.sendStatus(200);
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ X-ZITH Backend running on port ${PORT}`);
});
