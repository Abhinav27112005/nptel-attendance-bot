# =============================================================================
# FILE: extract_offer_letter.py
# PURPOSE: NPTEL offer letter PDF se details auto-nikalna — FREE, bina kisi paid API.
#
# WHY Claude API nahi? Offer letter ka format FIXED hai (har field ka clear label).
#   Fixed format = simple regex kaafi hai. Claude API paisa lega, yahan zaroorat nahi.
#
# LEARNING CONCEPT: PDF Text Extraction
#   PDF ek "dekhne wala" format hai (jaise photo), par andar text bhi hota hai.
#   pdfplumber library us text ko nikal deti hai as a normal string.
#   Phir hum regex (pattern matching) se zaroori fields dhoondhte hain.
#
# LEARNING CONCEPT: Regex (Regular Expression)
#   Regex = text mein pattern dhoondhne ka tareeka.
#   Example: "Internship ID\s*:\s*(\S+)" ka matlab:
#     "Internship ID" likha ho → uske baad spaces/colon → phir jo word aaye usse PAKDO
#
# INSTALL: pip install pdfplumber
#
# TEST (standalone):
#   python extract_offer_letter.py "W:\...\Offer Letter.pdf"
# =============================================================================

import sys
import re
import json

# pdfplumber — PDF se text nikalne wali free library
import pdfplumber


def extract_text_from_pdf(pdf_path: str) -> str:
    """
    PDF ke saare pages ka text ek string mein nikalta hai.

    HOW: pdfplumber har page kholta hai, extract_text() us page ka text deta hai.
         Hum sab jod ke ek bada string banate hain.
    """
    full_text = ""
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text() or ""  # None aaye to khaali
            full_text += page_text + "\n"
    return full_text


def find(pattern: str, text: str, default: str = "") -> str:
    """
    Ek regex pattern text mein dhoondhta hai aur pehla match (group 1) deta hai.

    re.IGNORECASE = chhota/bada letter dono chalega
    re.search = poore text mein kahin bhi dhoondho
    match.group(1) = bracket () wala captured hissa
    .strip() = aage-peeche ke spaces hatao
    """
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(1).strip() if match else default


def clean_stray(v: str) -> str:
    """
    PDF artifact theek karta hai: is offer letter mein har value ke PEHLE character
    ke baad ek extra (stray) space ghus jata hai.
      "P rof. Prabhjot..." → "Prof. Prabhjot..."
      "I IT Roorkee"       → "IIT Roorkee"
      "I n-person"         → "In-person"
      "1 2 weeks"          → "12 weeks"

    HOW: agar doosra character (index 1) space hai, to use hata do.
         Agar PDF saaf ho (artifact na ho), to index 1 space nahi hoga →
         kuch nahi badlega. Isliye safe hai.
    """
    v = v.strip()
    if len(v) > 1 and v[1] == ' ':
        v = v[0] + v[2:]
    # do ya zyada spaces ek mein badlo
    v = re.sub(r'\s{2,}', ' ', v)
    return v.strip()


def no_spaces(v: str) -> str:
    """Saare spaces hata do — ID aur dates ke liye (inme space hote hi nahi)."""
    return v.replace(' ', '').strip()


def convert_date(ddmmyyyy: str) -> str:
    """
    Offer letter mein date "19-05-2026" (DD-MM-YYYY) format mein hai.
    Hamare profile/form ko "2026-05-19" (YYYY-MM-DD) chahiye.
    Ye function ulta kar deta hai.
    """
    parts = ddmmyyyy.split('-')  # ["19","05","2026"]
    if len(parts) == 3:
        day, month, year = parts
        return f"{year}-{month}-{day}"  # "2026-05-19"
    return ddmmyyyy  # format alag ho to jaisa hai waisa hi


def extract_offer_letter(pdf_path: str) -> dict:
    """
    Offer letter PDF se saare fields nikaal ke ek dict banata hai.

    Returns: profile dict (mobile aur gmail ke bina — woh user daalega)
    """
    text = extract_text_from_pdf(pdf_path)

    # Har field ke liye ek regex. Label specific hai isliye galat match nahi hoga.
    # Phir clean_stray/no_spaces se PDF ka stray-space artifact theek karte hain.
    profile = {
        # "Internship ID: SUM26 0130 Date:..." → ID tak capture, space hatao → "SUM260130"
        "internship_id": no_spaces(find(r"Internship ID\s*:?\s*(.+?)\s*Date", text)),

        # "Dear Abhinav Kumar Jha," → Abhinav Kumar Jha
        "name": clean_stray(find(r"Dear\s+(.+?),", text)),

        # "1. Name of the Professor : P rof. Prabhjot Singh Chani"
        "professor": clean_stray(find(r"Name of the Professor\s*:?\s*(.+)", text)),

        # "2. Internship offering Institute : I IT Roorkee"
        "institute": clean_stray(find(r"offering Institute\s*:?\s*(.+)", text)),

        # "3. Mode of internship : I n-person"
        "mode": clean_stray(find(r"Mode of internship\s*:?\s*(.+)", text)),

        # "4. Duration of internship : 1 2 weeks"
        "duration": clean_stray(find(r"Duration of internship\s*:?\s*(.+)", text)),

        # "5. Start date : 1 9-05-2026" → space hatao → 19-05-2026 → convert → 2026-05-19
        # NOTE: [\d -]+ use kiya (\s nahi) taaki newline match na ho aur agli line na uthe.
        "start_date": convert_date(no_spaces(find(r"Start date\s*:?\s*([\d -]+)", text))),

        # "6. End date : 1 0-08-2026" → 2026-08-10
        "end_date": convert_date(no_spaces(find(r"End date\s*:?\s*([\d -]+)", text))),

        # Ye user khud register karte waqt daalega (PDF mein nahi hote)
        "mobile": "",
        "default_login_time": "09:45",
    }
    return profile


# Standalone test ke liye
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_offer_letter.py <path-to-pdf>")
        sys.exit(1)

    result = extract_offer_letter(sys.argv[1])
    # indent=2 = sundar formatting, ensure_ascii=False = Indian naam sahi dikhe
    print(json.dumps(result, indent=2, ensure_ascii=False))
