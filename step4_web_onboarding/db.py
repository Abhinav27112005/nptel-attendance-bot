# =============================================================================
# FILE: db.py
# PURPOSE: Python data layer — profile MongoDB mein ya local files mein save kare.
#          (db.js ka Python version — registration site iska use karega.)
#
# Same idea: .env mein MONGODB_URI hai → cloud, nahi → local files.
# =============================================================================

import os
import json
import base64
from datetime import datetime

# .env load karo (project root se). dotenv na ho to ignore.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

MONGODB_URI = os.environ.get('MONGODB_URI', '').strip()
DB_NAME = 'attendanceauto'
USERS_DIR = os.path.join(os.path.dirname(__file__), '..', 'users')


def using_cloud() -> bool:
    """Cloud (MongoDB) use kar rahe hain ya local files?"""
    return bool(MONGODB_URI) and 'PASTE_YOUR' not in MONGODB_URI


# MongoDB connection ek baar banao, reuse karo
_db = None
def _get_db():
    global _db
    if _db is None:
        from pymongo import MongoClient
        client = MongoClient(MONGODB_URI)
        _db = client[DB_NAME]
        print("[DB] MongoDB connected")
    return _db


def save_user(profile: dict, pdf_path: str = None):
    """
    Profile save karo. Cloud mode mein offer letter PDF bhi store ho (base64).

    LEARNING CONCEPT: upsert
        upsert = "update agar hai, insert agar nahi". Isse same internship_id
        dobara register kare to nayi entry nahi banti, purani update hoti hai.
    """
    if using_cloud():
        db = _get_db()
        # users collection mein profile (internship_id ke hisaab se upsert)
        db.users.update_one(
            {'internship_id': profile['internship_id']},
            {'$set': profile},
            upsert=True
        )
        # PDF ko alag collection mein store karo (base64 text ke roop mein)
        # WHY alag collection? users ko bot baar-baar padhta hai — bhaari PDF
        # us par bojh na daale, isliye offer_letters alag rakhte hain.
        if pdf_path and os.path.exists(pdf_path):
            with open(pdf_path, 'rb') as f:
                pdf_b64 = base64.b64encode(f.read()).decode('utf-8')
            db.offer_letters.update_one(
                {'internship_id': profile['internship_id']},
                {'$set': {
                    'internship_id': profile['internship_id'],
                    'filename': os.path.basename(pdf_path),
                    'pdf_base64': pdf_b64
                }},
                upsert=True
            )
    else:
        # LOCAL: users/ folder mein JSON file
        os.makedirs(USERS_DIR, exist_ok=True)
        path = os.path.join(USERS_DIR, profile['internship_id'] + '.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(profile, f, indent=2, ensure_ascii=False)


def find_user(internship_id: str = None, mobile: str = None) -> dict | None:
    """
    Dhoondho ki internship_id ya mobile pehle se registered hai ya nahi.
    Dono mein se koi bhi match kare to woh user return karta hai.
    Registration ke "already registered" check ke liye.
    """
    mobile = (mobile or '').replace('+', '').replace(' ', '')

    if using_cloud():
        db = _get_db()
        # $or — internship_id YA mobile match kare to mil jaaye
        query = {'$or': []}
        if internship_id:
            query['$or'].append({'internship_id': internship_id})
        if mobile:
            query['$or'].append({'mobile': mobile})
        if not query['$or']:
            return None
        return db.users.find_one(query, {'_id': 0})
    else:
        if not os.path.isdir(USERS_DIR):
            return None
        for fn in os.listdir(USERS_DIR):
            if not fn.endswith('.json'):
                continue
            with open(os.path.join(USERS_DIR, fn), encoding='utf-8') as f:
                p = json.load(f)
            if internship_id and p.get('internship_id') == internship_id:
                return p
            if mobile and p.get('mobile', '').replace('+', '').replace(' ', '') == mobile:
                return p
        return None


def get_shortlink(short_id: str) -> dict | None:
    """Short ID se full URL ka record laao (Flask /r/<id> ke liye)."""
    if using_cloud():
        return _get_db().shortlinks.find_one({'short_id': short_id})
    return None


def increment_shortlink_clicks(short_id: str):
    """Click count badhao analytics ke liye."""
    if using_cloud():
        _get_db().shortlinks.update_one(
            {'short_id': short_id},
            {'$inc': {'clicks': 1}, '$set': {'last_clicked': datetime.now()}}
        )


def get_link_stats_for(internship_id: str) -> dict | None:
    """Today's link generation stats (count + last_at) for a user."""
    if not using_cloud():
        return None
    today = datetime.now().strftime('%Y-%m-%d')
    return _get_db().link_stats.find_one(
        {'internship_id': internship_id, 'date': today},
        {'_id': 0}
    )


def get_recent_shortlinks(limit: int = 30) -> list:
    """Most recent shortlinks (for admin activity feed)."""
    if not using_cloud():
        return []
    return list(_get_db().shortlinks.find(
        {}, {'_id': 0}
    ).sort('created_at', -1).limit(limit))


def get_all_users() -> list:
    """Saare registered users (admin panel ke liye)."""
    if using_cloud():
        # _id field hata do (JSON-friendly banane ke liye)
        return list(_get_db().users.find({}, {'_id': 0}))
    else:
        users = []
        if os.path.isdir(USERS_DIR):
            for fn in os.listdir(USERS_DIR):
                if fn.endswith('.json'):
                    with open(os.path.join(USERS_DIR, fn), encoding='utf-8') as f:
                        users.append(json.load(f))
        return users
