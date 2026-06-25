"""
cleanup.py — Test data WIPE karne ke liye.

DEFAULT (PDFs preserved — admin panel ke liye useful):
  WIPES:
    - MongoDB: users, shortlinks, link_stats (profiles + ephemeral data)
    - Local: users/*.json, logs/attendance_state.json
  KEEPS:
    - MongoDB offer_letters collection (PDF metadata + base64)
    - Cloudinary NptelOfferLetter/ folder (uploaded PDFs)
    - Local offer_letters/*.pdf (cached copies)

FULL WIPE (--full): everything above PLUS PDFs from Cloudinary + DB + local.

USAGE:
  python cleanup.py              (confirmation maangega, PDFs safe)
  python cleanup.py --yes        (auto, PDFs safe)
  python cleanup.py --full --yes (auto + PDFs bhi hata do)

WARNING: WhatsApp session (.wwebjs_auth/) NEVER touched — warna QR scan
         dobara karna padega.
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


def wipe_mongo(include_pdfs: bool):
    """MongoDB collections drop karo. include_pdfs=False to keep offer_letters."""
    uri = os.environ.get('MONGODB_URI', '').strip()
    if not uri or 'PASTE_YOUR' in uri:
        print("[skip]  MongoDB skip — MONGODB_URI .env mein nahi.")
        return
    try:
        from pymongo import MongoClient
        client = MongoClient(uri)
        db = client['attendanceauto']
        # Always wiped — these are ephemeral / test-only
        to_drop = ['users', 'shortlinks', 'link_stats']
        if include_pdfs:
            to_drop.append('offer_letters')
        for coll_name in to_drop:
            if coll_name in db.list_collection_names():
                count = db[coll_name].count_documents({})
                db.drop_collection(coll_name)
                print(f"[OK]   MongoDB: dropped '{coll_name}' ({count} docs)")
            else:
                print(f"[skip] MongoDB: '{coll_name}' already empty")
        if not include_pdfs and 'offer_letters' in db.list_collection_names():
            kept = db['offer_letters'].count_documents({})
            print(f"[KEEP] MongoDB: offer_letters preserved ({kept} PDFs for admin panel)")
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
        result = cloudinary.api.delete_resources_by_prefix(
            'NptelOfferLetter/', resource_type='raw'
        )
        deleted = result.get('deleted', {})
        print(f"[OK]   Cloudinary: {len(deleted)} PDFs deleted from NptelOfferLetter/")
    except Exception as e:
        print(f"[FAIL] Cloudinary wipe fail: {e}")


def wipe_local_files(include_pdfs: bool):
    """Local users/*.json + logs/state always. offer_letters PDFs only if --full."""
    targets = [
        (os.path.join(ROOT, 'users', '*.json'), 'users/*.json'),
        (os.path.join(ROOT, 'logs', 'attendance_state.json'), 'logs/attendance_state.json'),
    ]
    if include_pdfs:
        targets.insert(1, (os.path.join(ROOT, 'offer_letters', '*.pdf'), 'offer_letters/*.pdf'))
    for pattern, label in targets:
        files = glob.glob(pattern)
        for f in files:
            try:
                os.remove(f)
            except Exception as e:
                print(f"   [warn] {f}: {e}")
        print(f"[OK]   Local: deleted {len(files)} file(s) at {label}")
    if not include_pdfs:
        pdfs = glob.glob(os.path.join(ROOT, 'offer_letters', '*.pdf'))
        if pdfs:
            print(f"[KEEP] Local: {len(pdfs)} PDF(s) in offer_letters/ preserved")


def main():
    auto = '--yes' in sys.argv or '-y' in sys.argv
    include_pdfs = '--full' in sys.argv

    print("=" * 60)
    if include_pdfs:
        print("FULL CLEANUP — ye sab DELETE karega:")
        print("  • MongoDB: users + offer_letters + shortlinks + link_stats")
        print("  • Cloudinary: NptelOfferLetter/ folder")
        print("  • Local: users/*.json + offer_letters/*.pdf + logs/state")
    else:
        print("CLEANUP (PDFs preserved for admin panel):")
        print("  WIPES:  MongoDB users + shortlinks + link_stats")
        print("          Local users/*.json + logs/state")
        print("  KEEPS:  MongoDB offer_letters + Cloudinary PDFs + local PDFs")
        print("  (Use --full to also delete PDFs)")
    print("=" * 60)
    print("(WhatsApp session ALWAYS safe — no QR rescan needed)")
    print()

    if not auto:
        ans = input("Sure? Type 'YES' to proceed: ").strip()
        if ans != 'YES':
            print("Abort.")
            return

    print()
    wipe_mongo(include_pdfs)
    if include_pdfs:
        wipe_cloudinary()
    else:
        print("[KEEP] Cloudinary: NptelOfferLetter/ preserved")
    wipe_local_files(include_pdfs)
    print()
    print("Cleanup done — fresh test ke liye ready!")


if __name__ == '__main__':
    main()
