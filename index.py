from http.server import BaseHTTPRequestHandler
import json
import psycopg2
from psycopg2.extras import RealDictCursor
import hashlib
import os

# Database
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def get_db_connection():
    try:
        return psycopg2.connect(DATABASE_URL)
    except:
        return None

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # CORS headers
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        
        # Return status
        response = {
            "status": "running",
            "app": "X-ZITH Backend on Vercel",
            "version": "3.0",
            "features": ["Auth", "Leaderboard", "Past Questions", "Textbooks", "Badges"]
        }
        self.wfile.write(json.dumps(response).encode())
    
    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode('utf-8')
            data = json.loads(body) if body else {}
        except:
            self.send_error(400, "Invalid JSON")
            return
        
        # CORS headers
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        
        action = data.get("action", "").strip().lower()
        
        # SIGNUP
        if action == "signup":
            username = data.get("username", "").strip()
            email = data.get("email", "").strip()
            password = data.get("password", "").strip()
            
            if not username or not email or not password:
                response = {"success": False, "error": "All fields required"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            if len(password) < 6:
                response = {"success": False, "error": "Password must be 6+ characters"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            password_hash = hash_password(password)
            conn = get_db_connection()
            
            if not conn:
                response = {"error": "Database error"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            try:
                cur = conn.cursor()
                
                # Check username
                cur.execute("SELECT id FROM users WHERE username = %s", (username,))
                if cur.fetchone():
                    conn.close()
                    response = {"success": False, "error": "Username already taken"}
                    self.wfile.write(json.dumps(response).encode())
                    return
                
                # Check email
                cur.execute("SELECT id FROM users WHERE email = %s", (email,))
                if cur.fetchone():
                    conn.close()
                    response = {"success": False, "error": "Email already registered"}
                    self.wfile.write(json.dumps(response).encode())
                    return
                
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
                
                conn.commit()
                cur.close()
                conn.close()
                
                response = {"success": True, "message": "Account created! Please login."}
                self.wfile.write(json.dumps(response).encode())
                return
                
            except Exception as e:
                conn.close()
                response = {"error": str(e)}
                self.wfile.write(json.dumps(response).encode())
                return
        
        # LOGIN
        elif action == "login":
            username = data.get("username", "").strip()
            password = data.get("password", "").strip()
            
            if not username or not password:
                response = {"success": False, "error": "Username and password required"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            password_hash = hash_password(password)
            conn = get_db_connection()
            
            if not conn:
                response = {"error": "Database error"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            try:
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute(
                    "SELECT id, username, email FROM users WHERE username = %s AND password_hash = %s",
                    (username, password_hash)
                )
                user = cur.fetchone()
                conn.close()
                
                if user:
                    response = {"success": True, "message": "Login successful", "user": dict(user)}
                    self.wfile.write(json.dumps(response).encode())
                else:
                    response = {"success": False, "error": "Invalid credentials"}
                    self.wfile.write(json.dumps(response).encode())
                return
                
            except Exception as e:
                conn.close()
                response = {"error": str(e)}
                self.wfile.write(json.dumps(response).encode())
                return
        
        # GET LEADERBOARD
        elif action == "get_leaderboard":
            conn = get_db_connection()
            
            if not conn:
                response = {"error": "Database error"}
                self.wfile.write(json.dumps(response).encode())
                return
            
            try:
                cur = conn.cursor(cursor_factory=RealDictCursor)
                cur.execute("SELECT * FROM leaderboard ORDER BY total_score DESC LIMIT 100")
                leaderboard = [dict(row) for row in cur.fetchall()]
                conn.close()
                
                response = {"success": True, "leaderboard": leaderboard}
                self.wfile.write(json.dumps(response).encode())
                return
                
            except Exception as e:
                conn.close()
                response = {"error": str(e)}
                self.wfile.write(json.dumps(response).encode())
                return
        
        else:
            response = {"error": f"Unknown action: {action}"}
            self.wfile.write(json.dumps(response).encode())
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
