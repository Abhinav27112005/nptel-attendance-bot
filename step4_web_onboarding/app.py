# =============================================================================
# FILE: app.py  (Step 4 — Registration Website)
# PURPOSE: Naya user yahan apna OFFER LETTER PDF upload kare → details apne aap
#          nikal jaayein → profile save ho jaaye. Phir woh WhatsApp bot use kar sake.
#
# LEARNING CONCEPT: Flask Web Server
#   Flask ek chhota web framework hai. Hum "routes" (URLs) define karte hain
#   aur batate hain har URL pe kya karna hai.
#   @app.route('/') = "jab koi homepage khole, ye function chalao"
#
# FLOW:
#   1. User site khole (GET /)            → upload form dikhe
#   2. PDF + mobile number bheje (POST)   → server PDF se details nikale
#   3. users/{internship_id}.json save    → success page dikhe
#
# RUN:
#   pip install flask pdfplumber
#   python app.py
#   Khole: http://localhost:5000
#   (Dost ke phone se: http://<laptop-ka-WiFi-IP>:5000)
# =============================================================================

from flask import Flask, request, render_template, jsonify, redirect, Response
import os
import json
import re
from datetime import datetime
from functools import wraps
from werkzeug.utils import secure_filename  # filename ko safe banata hai

# Apni extraction file import karo (FREE PDF reading — koi paid API nahi)
from extract_offer_letter import extract_offer_letter

# Data layer — profile MongoDB ya local files mein save karta hai
from db import (
    save_user, using_cloud, find_user,
    get_shortlink, increment_shortlink_clicks,
    get_all_users, get_link_stats_for, get_recent_shortlinks
)

# Cloudinary — offer letter PDF cloud pe store karne ke liye
from cloud_storage import upload_pdf

app = Flask(__name__)

# Bot ka WhatsApp number — wa.me link banane ke liye (verify button).
# Env var se aata hai taaki code mein hardcoded na ho.
BOT_WHATSAPP_NUMBER = os.environ.get('BOT_WHATSAPP_NUMBER', '919835262809')

# Admin panel password — env var se aata hai.
# WHY env var (hardcoded nahi)? Code GitHub pe jata hai, password .env mein safe.
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'changeme123')


def require_admin(f):
    """
    Decorator — Basic Auth check. /admin* routes pe lagao.
    HOW: browser khud login popup dikhata hai (HTTP standard mechanism).
    User: 'admin', password: ADMIN_PASSWORD env var.
    """
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth = request.authorization
        if not auth or auth.password != ADMIN_PASSWORD:
            return Response(
                'Admin password required.',
                401,
                {'WWW-Authenticate': 'Basic realm="NPTEL Admin"'}
            )
        return f(*args, **kwargs)
    return wrapper

# --- FOLDERS -----------------------------------------------------------------
USERS_DIR = os.path.join(os.path.dirname(__file__), '..', 'users')          # profiles
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), '..', 'offer_letters')  # PDFs yahan store

# Folder na ho to bana do (pehli baar)
os.makedirs(UPLOAD_DIR, exist_ok=True)


def sanitize(s: str) -> str:
    """Filename/ID se khatarnaak characters hatao (jaise / \\ jo path todd dein)."""
    return re.sub(r'[^\w\-]', '', s)


@app.route('/')
def index():
    """Homepage — upload form dikhao."""
    return render_template('register.html')


@app.route('/register', methods=['POST'])
def register():
    """
    POST: offer letter PDF + mobile receive karo → extract → profile save.

    LEARNING CONCEPT: File Upload in Flask
        request.files['offer_letter'] = jo file user ne upload ki
        request.form['mobile']        = text fields
    """
    # --- 1. File aayi ya nahi check karo ---
    if 'offer_letter' not in request.files:
        return jsonify({"error": "Koi PDF upload nahi hui."}), 400

    pdf_file = request.files['offer_letter']
    if pdf_file.filename == '':
        return jsonify({"error": "File select karo pehle."}), 400

    if not pdf_file.filename.lower().endswith('.pdf'):
        return jsonify({"error": "Sirf PDF file chalegi."}), 400

    # --- 2. Mobile number lo (PDF mein nahi hota, user deta hai) ---
    mobile = request.form.get('mobile', '').strip().replace('+', '').replace(' ', '')
    if not re.fullmatch(r'\d{10,15}', mobile):
        return jsonify({"error": "Sahi mobile number daalo (country code ke saath, jaise 9198XXXXXXXX)."}), 400

    login_time = request.form.get('default_login_time', '09:45').strip() or '09:45'

    # --- 3. PDF ko disk pe save karo (authenticity record) ---
    # Filename safe banao. Temp naam pehle, baad mein internship_id se rename.
    temp_name = secure_filename(pdf_file.filename)
    temp_path = os.path.join(UPLOAD_DIR, f"temp_{datetime.now().strftime('%Y%m%d%H%M%S')}_{temp_name}")
    pdf_file.save(temp_path)

    # --- 4. PDF se details nikalo ---
    try:
        profile = extract_offer_letter(temp_path)
    except Exception as e:
        os.remove(temp_path)  # kharab file hatao
        return jsonify({"error": f"PDF padhne mein dikkat: {str(e)}"}), 500

    # --- 5. Extraction sahi hui? (internship_id mil gaya?) ---
    if not profile.get('internship_id'):
        os.remove(temp_path)
        return jsonify({"error": "PDF se Internship ID nahi mili. Sahi NPTEL offer letter upload karo."}), 400

    # --- 5b. Duplicate check — pehle se registered ho to "already registered" deta hai,
    #         lekin error nahi — frontend ko sab kuch deta hai taaki user ko
    #         "Verify on WhatsApp" button + summary card dikha sake (jaise fresh
    #         registration ke baad). LINK abhi tak nahi hua to button tap karke
    #         flow complete kar lega.
    existing = find_user(internship_id=profile['internship_id'], mobile=mobile)
    if existing:
        os.remove(temp_path)
        # WhatsApp link button — wahi format jaisa fresh registration mein hai.
        verify_url = (
            f"https://wa.me/{BOT_WHATSAPP_NUMBER}"
            f"?text=LINK%20{existing.get('internship_id', '')}"
        )
        # Conflict ki wajah (kahaan match hua)
        matched_by_id = existing.get('internship_id') == profile['internship_id']
        match_field = "Internship ID" if matched_by_id else "Mobile number"
        already_linked = bool(existing.get('whatsapp_id'))

        # User-friendly message — already linked vs needs LINK
        if already_linked:
            message = (
                f"Already registered & linked! "
                f"Just send *WORK: ...* on WhatsApp to mark attendance."
            )
        else:
            message = (
                f"Already registered (matched by {match_field}). "
                f"One more step: tap the green button below to link your WhatsApp."
            )

        # Frontend HTTP 200 + already_registered=true ko same success card jaisi
        # treat karega — error red box ki jagah sundar info card.
        return jsonify({
            "success": True,
            "already_registered": True,
            "already_linked": already_linked,
            "message": message,
            "verify_url": verify_url,
            "profile": {
                "internship_id": existing.get('internship_id', ''),
                "name": existing.get('name', ''),
                "institute": existing.get('institute', ''),
                "professor": existing.get('professor', ''),
                "mode": existing.get('mode', ''),
                "duration": existing.get('duration', ''),
                "start_date": existing.get('start_date', ''),
                "end_date": existing.get('end_date', ''),
                "mobile": existing.get('mobile', ''),
            }
        })

    # User ke diye fields jodo
    profile['mobile'] = mobile
    profile['default_login_time'] = login_time
    profile['registered_at'] = datetime.now().isoformat()

    # --- 6. PDF ko internship_id ke naam se rename karo ---
    final_pdf = os.path.join(UPLOAD_DIR, f"{sanitize(profile['internship_id'])}.pdf")
    os.replace(temp_path, final_pdf)
    profile['offer_letter_file'] = os.path.basename(final_pdf)

    # --- 7. PDF ko Cloudinary pe upload karo (permanent storage + authenticity) ---
    try:
        cloud_url = upload_pdf(final_pdf, sanitize(profile['internship_id']))
        if cloud_url:
            profile['offer_letter_url'] = cloud_url   # Cloudinary ka permanent link
            print(f"[Cloudinary] Uploaded: {cloud_url}")
        else:
            print("[Cloudinary] Configured nahi — PDF cloud pe upload nahi hua (skip).")
    except Exception as e:
        # Cloudinary fail ho to bhi registration na ruke — bas warning
        print(f"[Cloudinary] Upload error (non-fatal): {e}")

    # --- 8. Profile save karo (cloud MongoDB ya local files — db.py decide karta hai) ---
    save_user(profile)
    print(f"[Register] Saved {profile['internship_id']} ({'cloud' if using_cloud() else 'local'})")

    # --- 8. Success — extracted details wapas bhejo (user verify kar le) ---
    # WhatsApp verify link: user is link pe click karega → unka WhatsApp
    # khulega bot ki chat ke saath "LINK SUM260111" pre-filled. Bas Send
    # dabana hai. Bot @lid ko profile se link kar dega — koi typing nahi.
    verify_url = (
        f"https://wa.me/{BOT_WHATSAPP_NUMBER}"
        f"?text=LINK%20{profile['internship_id']}"
    )

    return jsonify({
        "success": True,
        "message": "Registration ho gaya! Niche 'Verify on WhatsApp' button dabao.",
        "verify_url": verify_url,
        "profile": {
            "internship_id": profile['internship_id'],
            "name": profile['name'],
            "institute": profile['institute'],
            "professor": profile['professor'],
            "mode": profile['mode'],
            "duration": profile['duration'],
            "start_date": profile['start_date'],
            "end_date": profile['end_date'],
            "mobile": profile['mobile'],
        }
    })


@app.route('/r/<short_id>')
def short_redirect(short_id):
    """
    Short link redirect: /r/k7m2pq → asli Google Forms pre-filled URL.

    WHY: WhatsApp pe Google Forms ka long URL bhejne se ugly + suspicious lagta hai.
         Hum apne domain pe ek chhota link bhejte hain → click pe redirect.
         Side benefit: click count track kar sakte hain.
    """
    record = get_shortlink(short_id)
    if not record:
        return render_template('link_expired.html'), 410   # 410 Gone = used to exist

    # Expiry check (in case TTL hasn't swept it yet, OR user clicks moments after deadline).
    # We compare against UTC now since MongoDB stores in UTC.
    expires_at = record.get('expires_at')
    if expires_at and datetime.utcnow() > expires_at:
        return render_template('link_expired.html'), 410

    increment_shortlink_clicks(short_id)
    return redirect(record['full_url'], code=302)


# ============================================================================
# ADMIN PANEL — protected by Basic Auth (ADMIN_PASSWORD env var)
# ============================================================================

@app.route('/admin')
@require_admin
def admin_dashboard():
    """Render the admin HTML shell — data loads via /api/admin/users."""
    return render_template('admin.html')


@app.route('/api/admin/users')
@require_admin
def admin_users():
    """
    Return JSON: all registered users with today's link stats.
    Sorted: most recently registered first.
    """
    users = get_all_users()
    enriched = []
    for u in users:
        stats = get_link_stats_for(u.get('internship_id')) if u.get('internship_id') else None
        u['links_today'] = stats.get('count') if stats else 0
        u['last_link_at'] = stats.get('last_at').isoformat() if (stats and stats.get('last_at')) else None
        enriched.append(u)
    # Newest registrations first
    enriched.sort(key=lambda x: x.get('registered_at', ''), reverse=True)
    return jsonify({"users": enriched, "total": len(enriched)})


@app.route('/api/admin/recent')
@require_admin
def admin_recent_activity():
    """Recent shortlinks generated (activity feed)."""
    recent = get_recent_shortlinks(50)
    # ObjectId / datetime serialization
    cleaned = []
    for r in recent:
        cleaned.append({
            'short_id': r.get('short_id'),
            'internship_id': r.get('internship_id'),
            'clicks': r.get('clicks', 0),
            'created_at': r.get('created_at').isoformat() if r.get('created_at') else None,
            'expires_at': r.get('expires_at').isoformat() if r.get('expires_at') else None,
        })
    return jsonify({"shortlinks": cleaned})


if __name__ == '__main__':
    # host='0.0.0.0' = same WiFi ke doosre devices (phone) bhi khol sakein
    # port=5000 = http://localhost:5000
    app.run(debug=True, host='0.0.0.0', port=5000)
