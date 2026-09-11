import json
import psycopg2
from psycopg2.extras import RealDictCursor
import hashlib
import os
import requests
from datetime import datetime

# Get database URL from environment
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

def hash_password(password):
    """SHA256 hash password"""
    return hashlib.sha256(password.encode()).hexdigest()

def get_db_connection():
    """Get database connection"""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        return conn
    except Exception as e:
        return None

def handler(request):
    """Main API handler for Vercel"""
    
    # CORS headers
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json"
    }
    
    # Handle OPTIONS
    if request.method == "OPTIONS":
        return ("", 200, headers)
    
    # Handle GET requests (status check)
    if request.method == "GET":
        response = {
            "status": "running",
            "app": "X-ZITH Backend on Vercel",
            "version": "3.0",
            "features": ["Auth", "Leaderboard", "Past Questions", "Textbooks", "Badges"]
        }
        return (json.dumps(response), 200, headers)
    
    try:
        data = json.loads(request.body) if request.body else {}
    except:
        return json.dumps({"error": "Invalid JSON"}), 400, headers
    
    action = data.get("action", "").strip().lower()
    
    # SIGNUP
    if action == "signup":
        username = data.get("username", "").strip()
        email = data.get("email", "").strip()
        password = data.get("password", "").strip()
        
        if not username or not email or not password:
            return json.dumps({"success": False, "error": "All fields required"}), 400, headers
        
        if len(password) < 6:
            return json.dumps({"success": False, "error": "Password must be 6+ characters"}), 400, headers
        
        password_hash = hash_password(password)
        conn = get_db_connection()
        if not conn:
            return json.dumps({"error": "Database error"}), 500, headers
        
        try:
            cur = conn.cursor()
            
            # Check if username exists
            cur.execute("SELECT id FROM users WHERE username = %s", (username,))
            if cur.fetchone():
                conn.close()
                return json.dumps({"success": False, "error": "Username already taken"}), 400, headers
            
            # Check if email exists
            cur.execute("SELECT id FROM users WHERE email = %s", (email,))
            if cur.fetchone():
                conn.close()
                return json.dumps({"success": False, "error": "Email already registered"}), 400, headers
            
            # Insert user
            cur.execute(
                """INSERT INTO users (username, email, password_hash, badges_earned, unseen_badges)
                   VALUES (%s, %s, %s, %s, %s)""",
                (username, email, password_hash, "1", "1")
            )
            
            # Add to leaderboard
            cur.execute(
                """INSERT INTO leaderboard (username, total_score, streak, quizzes_completed, questions_answered, badges_count)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (username, 0, 1, 0, 0, 1)
            )
            
            # Award welcome badge
            cur.execute(
                """INSERT INTO user_badges (username, badge_id, badge_name, badge_emoji, points_required)
                   VALUES (%s, %s, %s, %s, %s)""",
                (username, 1, "Welcome Aboard", "🎉", 0)
            )
            
            conn.commit()
            cur.close()
            conn.close()
            
            return json.dumps({"success": True, "message": "Account created! Please login."}), 200, headers
        except Exception as e:
            conn.close()
            return json.dumps({"success": False, "error": str(e)}), 400, headers
    
    # LOGIN
    elif action == "login":
        username = data.get("username", "").strip()
        password = data.get("password", "").strip()
        
        if not username or not password:
            return json.dumps({"success": False, "error": "Username and password required"}), 400, headers
        
        password_hash = hash_password(password)
        conn = get_db_connection()
        if not conn:
            return json.dumps({"error": "Database error"}), 500, headers
        
        try:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(
                "SELECT * FROM users WHERE username = %s AND password_hash = %s",
                (username, password_hash)
            )
            user = cur.fetchone()
            cur.close()
            conn.close()
            
            if user:
                return json.dumps({
                    "success": True,
                    "user": {
                        "username": user["username"],
                        "email": user["email"],
                        "total_score": user["total_score"],
                        "badges_earned": user["badges_earned"],
                        "unseen_badges": user["unseen_badges"],
                        "streak": user["streak"],
                        "quizzes_taken": user["quizzes_taken"],
                        "exam_questions": user["exam_questions"]
                    }
                }), 200, headers
            else:
                return json.dumps({"success": False, "error": "Wrong username or password"}), 401, headers
        except Exception as e:
            conn.close()
            return json.dumps({"error": str(e)}), 500, headers
    
    # GET LEADERBOARD
    elif action == "get_leaderboard":
        conn = get_db_connection()
        if not conn:
            return json.dumps({"error": "Database error"}), 500, headers
        
        try:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(
                """SELECT username, total_score, streak, quizzes_completed, badges_count
                   FROM leaderboard
                   ORDER BY total_score DESC
                   LIMIT 10"""
            )
            users = cur.fetchall()
            cur.close()
            conn.close()
            
            return json.dumps({
                "success": True,
                "leaderboard": [dict(u) for u in users]
            }), 200, headers
        except Exception as e:
            conn.close()
            return json.dumps({"error": str(e)}), 500, headers
    
    # GET BADGES
    elif action == "get_badges":
        username = data.get("username", "").strip()
        if not username:
            return json.dumps({"error": "Username required"}), 400, headers
        
        conn = get_db_connection()
        if not conn:
            return json.dumps({"error": "Database error"}), 500, headers
        
        try:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(
                """SELECT badge_id, badge_name, badge_emoji, points_required, earned_at
                   FROM user_badges
                   WHERE username = %s
                   ORDER BY badge_id ASC""",
                (username,)
            )
            badges = cur.fetchall()
            cur.close()
            conn.close()
            
            return json.dumps({
                "success": True,
                "username": username,
                "badges": [dict(b) for b in badges]
            }), 200, headers
        except Exception as e:
            conn.close()
            return json.dumps({"error": str(e)}), 500, headers
    
    # GET PAST QUESTIONS
    elif action == "get_past_questions":
        exam_type = data.get("exam_type", "").strip()
        subject = data.get("subject", "").strip()
        limit = data.get("limit", 10)
        
        if not exam_type or not subject:
            return json.dumps({"error": "Exam type and subject required"}), 400, headers
        
        conn = get_db_connection()
        if not conn:
            return json.dumps({"error": "Database error"}), 500, headers
        
        try:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(
                """SELECT question_id, question_text, option_a, option_b, option_c, option_d, 
                          year, question_number, difficulty_level
                   FROM past_questions
                   WHERE exam_type = %s AND subject = %s
                   LIMIT %s""",
                (exam_type, subject, limit)
            )
            questions = cur.fetchall()
            cur.close()
            conn.close()
            
            return json.dumps({
                "success": True,
                "exam_type": exam_type,
                "subject": subject,
                "questions": [dict(q) for q in questions]
            }), 200, headers
        except Exception as e:
            conn.close()
            return json.dumps({"error": str(e)}), 500, headers
    
    # GET TEXTBOOKS
    elif action == "get_textbooks":
        subject = data.get("subject", "").strip()
        limit = data.get("limit", 10)
        
        if not subject:
            return json.dumps({"error": "Subject required"}), 400, headers
        
        conn = get_db_connection()
        if not conn:
            return json.dumps({"error": "Database error"}), 500, headers
        
        try:
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(
                """SELECT textbook_id, subject, topic, is_ai_generated, difficulty_level, views
                   FROM textbooks
                   WHERE subject = %s
                   LIMIT %s""",
                (subject, limit)
            )
            textbooks = cur.fetchall()
            cur.close()
            conn.close()
            
            return json.dumps({
                "success": True,
                "subject": subject,
                "textbooks": [dict(t) for t in textbooks]
            }), 200, headers
        except Exception as e:
            conn.close()
            return json.dumps({"error": str(e)}), 500, headers
    
    # UPDATE SCORE
    elif action == "update_score":
        username = data.get("username", "").strip()
        points = data.get("points", 0)
        activity_type = data.get("type", "")
        details = data.get("details", "")
        
        if not username:
            return json.dumps({"error": "Username required"}), 400, headers
        
        conn = get_db_connection()
        if not conn:
            return json.dumps({"error": "Database error"}), 500, headers
        
        try:
            cur = conn.cursor()
            
            cur.execute(
                """UPDATE users SET total_score = total_score + %s WHERE username = %s""",
                (points, username)
            )
            
            cur.execute(
                """INSERT INTO activity (username, type, details, points)
                   VALUES (%s, %s, %s, %s)""",
                (username, activity_type, details, points)
            )
            
            cur.execute(
                """UPDATE leaderboard SET total_score = total_score + %s WHERE username = %s""",
                (points, username)
            )
            
            conn.commit()
            cur.close()
            conn.close()
            
            return json.dumps({"success": True, "message": f"+{points} points awarded"}), 200, headers
        except Exception as e:
            conn.close()
            return json.dumps({"error": str(e)}), 500, headers
    
    else:
        return json.dumps({"error": f"Unknown action: {action}"}), 400, headers
