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

from flask import Flask, request, render_template, jsonify
import os
import json
import re
from datetime import datetime
from werkzeug.utils import secure_filename  # filename ko safe banata hai

# Apni extraction file import karo (FREE PDF reading — koi paid API nahi)
from extract_offer_letter import extract_offer_letter

# Data layer — profile MongoDB ya local files mein save karta hai
from db import save_user, using_cloud

# Cloudinary — offer letter PDF cloud pe store karne ke liye
from cloud_storage import upload_pdf

app = Flask(__name__)

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
    return jsonify({
        "success": True,
        "message": "Registration ho gaya! Ab WhatsApp pe 'WORK: ...' bhej ke attendance lo.",
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


if __name__ == '__main__':
    # host='0.0.0.0' = same WiFi ke doosre devices (phone) bhi khol sakein
    # port=5000 = http://localhost:5000
    app.run(debug=True, host='0.0.0.0', port=5000)
