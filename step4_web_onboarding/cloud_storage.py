# =============================================================================
# FILE: cloud_storage.py
# PURPOSE: Offer letter PDF ko Cloudinary pe upload karta hai aur uska URL deta hai.
#
# LEARNING CONCEPT: Cloud File Storage
#   Render ka filesystem "ephemeral" hai — restart pe files udd jaati hain.
#   Isliye PDF ko Cloudinary (ek file-storage service) pe rakhte hain.
#   Cloudinary ek permanent URL deta hai jisse PDF kabhi bhi access kar sakein.
#
# LEARNING CONCEPT: CLOUDINARY_URL
#   Cloudinary ek single env var se configure ho jata hai:
#     CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
#   cloudinary library is env var ko apne aap padh leti hai.
# =============================================================================

import os

# .env load karo (CLOUDINARY_URL isme hai)
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

# Folder jisme saari offer letters jaayengi (tumne ye naam diya tha)
CLOUDINARY_FOLDER = "NptelOfferLetter"


def is_configured() -> bool:
    """Cloudinary set hai ya nahi? (CLOUDINARY_URL hai aur placeholder nahi)"""
    url = os.environ.get('CLOUDINARY_URL', '')
    return bool(url) and 'PASTE_YOUR' not in url


def upload_pdf(pdf_path: str, internship_id: str) -> str | None:
    """
    PDF ko Cloudinary ke NptelOfferLetter folder mein upload karta hai.

    Args:
        pdf_path: local PDF file ka path
        internship_id: file ka naam isse banega (jaise SUM260130)

    Returns:
        Cloudinary ka secure URL (string), ya None agar Cloudinary set nahi hai.

    WHY resource_type="raw"?
        PDF ko "raw" file ki tarah store karte hain (jaisा hai waisा).
        Isse Cloudinary use bina kisi processing ke seedha store/return karta hai.
    """
    if not is_configured():
        # Cloudinary set nahi — None do (registration phir bhi chalega, bas PDF cloud pe nahi)
        return None

    # Library yahan import karte hain (taaki na ho to poora app na toote)
    import cloudinary
    import cloudinary.uploader

    # cloudinary.config() apne aap CLOUDINARY_URL env var se configure ho jata hai
    cloudinary.config(secure=True)

    # Upload karo. public_id = internship_id se file ka naam fix rahe (dobara upload = replace).
    result = cloudinary.uploader.upload(
        pdf_path,
        resource_type="raw",            # PDF as-is store karo
        folder=CLOUDINARY_FOLDER,       # "NptelOfferLetter" folder mein
        public_id=internship_id,        # file ka naam = internship ID
        overwrite=True                  # dobara register kare to purani replace ho
    )

    # secure_url = https wala permanent link
    return result.get('secure_url')
