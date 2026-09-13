const { Pool } = require('pg');
const crypto = require('crypto');

// Database pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Hash password
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Main handler
module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).set(corsHeaders).end();
    return;
  }

  // Set CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  try {
    // GET - health check
    if (req.method === 'GET') {
      const response = {
        status: 'running',
        app: 'X-ZITH Backend on Vercel',
        version: '3.0',
        timestamp: new Date().toISOString(),
      };
      res.status(200).json(response);
      return;
    }

    // POST - handle actions
    if (req.method === 'POST') {
      const { action, username, email, password } = req.body || {};

      // SIGNUP
      if (action === 'signup') {
        if (!username || !email || !password) {
          res.status(400).json({ success: false, error: 'All fields required' });
          return;
        }

        if (password.length < 6) {
          res.status(400).json({ success: false, error: 'Password must be 6+ characters' });
          return;
        }

        const passwordHash = hashPassword(password);

        try {
          // Check username exists
          const userCheck = await pool.query(
            'SELECT id FROM users WHERE username = $1',
            [username]
          );
          if (userCheck.rows.length > 0) {
            res.status(400).json({ success: false, error: 'Username already taken' });
            return;
          }

          // Check email exists
          const emailCheck = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
          );
          if (emailCheck.rows.length > 0) {
            res.status(400).json({ success: false, error: 'Email already registered' });
            return;
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

          res.status(200).json({ success: true, message: 'Account created! Please login.' });
          return;
        } catch (err) {
          console.error('Signup error:', err);
          res.status(500).json({ error: 'Database error: ' + err.message });
          return;
        }
      }

      // LOGIN
      if (action === 'login') {
        if (!username || !password) {
          res.status(400).json({ success: false, error: 'Username and password required' });
          return;
        }

        const passwordHash = hashPassword(password);

        try {
          const result = await pool.query(
            'SELECT id, username, email FROM users WHERE username = $1 AND password_hash = $2',
            [username, passwordHash]
          );

          if (result.rows.length > 0) {
            res.status(200).json({
              success: true,
              message: 'Login successful',
              user: result.rows[0],
            });
          } else {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
          }
          return;
        } catch (err) {
          console.error('Login error:', err);
          res.status(500).json({ error: 'Database error: ' + err.message });
          return;
        }
      }

      // GET LEADERBOARD
      if (action === 'get_leaderboard') {
        try {
          const result = await pool.query(
            'SELECT * FROM leaderboard ORDER BY total_score DESC LIMIT 100'
          );
          res.status(200).json({ success: true, leaderboard: result.rows });
          return;
        } catch (err) {
          console.error('Leaderboard error:', err);
          res.status(500).json({ error: 'Database error: ' + err.message });
          return;
        }
      }

      // Unknown action
      res.status(400).json({ error: `Unknown action: ${action}` });
      return;
    }

    // Method not allowed
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
