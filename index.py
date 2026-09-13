import json
import psycopg2
from psycopg2.extras import RealDictCursor
import hashlib
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def get_db_connection():
    try:
        return psycopg2.connect(DATABASE_URL)
    except Exception as e:
        print(f"DB Error: {e}")
        return None

def handler(request):
    """Vercel serverless function handler"""
    
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json"
    }
    
    # Handle preflight
    if request.method == "OPTIONS":
        return ("", 200, headers)
    
    # Handle GET - return status
    if request.method == "GET":
        response = {
            "status": "running",
            "app": "X-ZITH Backend on Vercel",
            "version": "3.0",
            "timestamp": "2026-09-13"
        }
        return (json.dumps(response), 200, headers)
    
    # Handle POST
    if request.method == "POST":
        try:
            body = request.body
            if isinstance(body, bytes):
                body = body.decode('utf-8')
            data = json.loads(body) if body else {}
        except:
            return (json.dumps({"error": "Invalid JSON"}), 400, headers)
        
        action = data.get("action", "").strip().lower()
        
        # SIGNUP
        if action == "signup":
            username = data.get("username", "").strip()
            email = data.get("email", "").strip()
            password = data.get("password", "").strip()
            
            if not username or not email or not password:
                return (json.dumps({"success": False, "error": "All fields required"}), 400, headers)
            
            if len(password) < 6:
                return (json.dumps({"success": False, "error": "Password must be 6+ characters"}), 400, headers)
            
            password_hash = hash_password(password)
            conn = get_db_connection()
            
            if not conn:
                return (json.dumps({"error": "Database connection failed"}), 500, headers)
            
            try:
                cur = conn.cursor()
                
                # Check if username exists
                cur.execute("SELECT id FROM users WHERE username = %s", (username,))
                if cur.fetchone():
                    conn.close()
                    return (json.dumps({"success": False, "error": "Username already taken"}), 400, headers)
                
                # Check if email exists
                cur.execute("SELECT id FROM users WHERE email = %s", (email,))
                if cur.fetchone():
                    conn.close()
                    return (json.dumps({"success": False, "error": "Email already registered"}), 400, headers)
                
                # Insert user
                cur.execute(
                    "INSERT INTO users (username, email, password_hash, badges_earned, unseen_badges) VALUES (%s, %s, %s, %s, %s)",
                    (username, email, password_hash, "1", "1")
                )
                
                # Add to leaderboard
                cur.execute(
                    "INSERT INTO leaderboard (username, total_score, streak, quizzes_completed, questions_answered, badges_count) VALUES (%s, %s, %s, %s, %s, %s)",
                    (username, 0, 1, 0, 0, 1)
                )
                
                conn.commit()
                conn.close()
                
                return (json.dumps({"success": True, "message": "Account created! Please login."}), 200, headers)
                
            except Exception as e:
                conn.close()
                return (json.dumps({"error": str(e)}), 500, headers)
        
        # LOGIN
        elif action == "login":
            username = data.get("username", "").strip()
            password = data.get("password", "").strip()
            
            if not username or not password:
                return (json.dumps({"success": False, "error": "Username and password required"}), 400, headers)
            
            password_hash = hash_password(password)
            conn = get_db_connection()
            
            if not conn:
                return (json.dumps({"error": "Database connection failed"}), 500, headers)
            
            try:
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute(
                    "SELECT id, username, email FROM users WHERE username = %s AND password_hash = %s",
                    (username, password_hash)
                )
                user = cur.fetchone()
                conn.close()
                
                if user:
                    return (json.dumps({"success": True, "message": "Login successful", "user": dict(user)}), 200, headers)
                else:
                    return (json.dumps({"success": False, "error": "Invalid credentials"}), 401, headers)
                    
            except Exception as e:
                conn.close()
                return (json.dumps({"error": str(e)}), 500, headers)
        
        # GET LEADERBOARD
        elif action == "get_leaderboard":
            conn = get_db_connection()
            
            if not conn:
                return (json.dumps({"error": "Database connection failed"}), 500, headers)
            
            try:
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute("SELECT * FROM leaderboard ORDER BY total_score DESC LIMIT 100")
                leaderboard = [dict(row) for row in cur.fetchall()]
                conn.close()
                
                return (json.dumps({"success": True, "leaderboard": leaderboard}), 200, headers)
                
            except Exception as e:
                conn.close()
                return (json.dumps({"error": str(e)}), 500, headers)
        
        else:
            return (json.dumps({"error": f"Unknown action: {action}"}), 400, headers)
    
    return (json.dumps({"error": "Method not allowed"}), 405, headers)
