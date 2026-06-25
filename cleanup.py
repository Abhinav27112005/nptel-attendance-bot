"""
cleanup.py — Saara test data WIPE karne ke liye.

WIPES:
  - MongoDB Atlas: users + offer_letters collections (saare profiles)
  - Cloudinary: NptelOfferLetter/ folder ke saare PDFs
  - Local: users/*.json, offer_letters/*.pdf
  - logs/attendance_state.json (reminder tracking)

USAGE:
  python cleanup.py            (confirmation maangega)
  python cleanup.py --yes      (bina poochhe wipe — careful!)

WARNING: yeh sab data permanently delete karta hai. WhatsApp session
         (.wwebjs_auth/) NAHI chhedta (warna QR scan dobara karna padega).
"""
import os
import sys
import shutil
import glob

ROOT = os.path.dirname(os.path.abspath(__file__))

# .env load
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, '.env'))
except ImportError:
    pass


def wipe_mongo():
    """MongoDB users + offer_letters collections drop karo."""
    uri = os.environ.get('MONGODB_URI', '').strip()
    if not uri or 'PASTE_YOUR' in uri:
        print("[skip]  MongoDB skip — MONGODB_URI .env mein nahi.")
        return
    try:
        from pymongo import MongoClient
        client = MongoClient(uri)
        db = client['attendanceauto']
        for coll_name in ['users', 'offer_letters']:
            if coll_name in db.list_collection_names():
                count = db[coll_name].count_documents({})
                db.drop_collection(coll_name)
                print(f"[OK] MongoDB: dropped '{coll_name}' ({count} docs)")
            else:
                print(f"[skip]  MongoDB: '{coll_name}' already khaali")
        client.close()
    except Exception as e:
        print(f"[FAIL] MongoDB wipe fail: {e}")


def wipe_cloudinary():
    """Cloudinary se NptelOfferLetter/ folder ke saare resources delete."""
    url = os.environ.get('CLOUDINARY_URL', '').strip()
    if not url or 'PASTE_YOUR' in url:
        print("[skip]  Cloudinary skip — CLOUDINARY_URL .env mein nahi.")
        return
    try:
        import cloudinary
        import cloudinary.api
        cloudinary.config(secure=True)
        # raw PDFs hain, isliye resource_type='raw'
        result = cloudinary.api.delete_resources_by_prefix(
            'NptelOfferLetter/', resource_type='raw'
        )
        deleted = result.get('deleted', {})
        print(f"[OK] Cloudinary: {len(deleted)} PDFs deleted from NptelOfferLetter/")
    except Exception as e:
        print(f"[FAIL] Cloudinary wipe fail: {e}")


def wipe_local_files():
    """Local users/*.json, offer_letters/*.pdf, logs/attendance_state.json."""
    targets = [
        (os.path.join(ROOT, 'users', '*.json'), 'users/*.json'),
        (os.path.join(ROOT, 'offer_letters', '*.pdf'), 'offer_letters/*.pdf'),
        (os.path.join(ROOT, 'logs', 'attendance_state.json'), 'logs/attendance_state.json'),
    ]
    for pattern, label in targets:
        files = glob.glob(pattern)
        for f in files:
            try:
                os.remove(f)
            except Exception as e:
                print(f"   [warn]  {f}: {e}")
        print(f"[OK] Local: deleted {len(files)} file(s) at {label}")


def main():
    auto = '--yes' in sys.argv or '-y' in sys.argv

    print("=" * 60)
    print("CLEANUP — ye sab DELETE karega:")
    print("  • MongoDB Atlas: users + offer_letters collections")
    print("  • Cloudinary: NptelOfferLetter/ folder")
    print("  • Local: users/*.json, offer_letters/*.pdf, logs/state")
    print("=" * 60)
    print("(WhatsApp session SAFE rahega — QR scan dobara nahi karna)")
    print()

    if not auto:
        ans = input("Sure? Type 'YES' to proceed: ").strip()
        if ans != 'YES':
            print("Abort.")
            return

    print()
    wipe_mongo()
    wipe_cloudinary()
    wipe_local_files()
    print()
    print("Cleanup done — fresh test ke liye ready!")


if __name__ == '__main__':
    main()
