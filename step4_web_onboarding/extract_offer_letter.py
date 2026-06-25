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

    LEARNING CONCEPT: layout=True
        Kuch NPTEL offer letters "fillable PDF" hote hain — values labels
        ke SAME y-coordinate pe overlay hote hain par alag text-layer pe.
        Default extract_text() un overlay values ko MISS kar deta hai!
        layout=True spatial layout preserve karta hai (column-aligned text
        with spaces), jisse overlay values bhi sahi line pe aa jaate hain.

        clean_stray()/no_spaces() helpers extra spaces handle kar lete hain.
    """
    full_text = ""
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            # layout=True zaroori hai fillable-form PDFs ke liye
            page_text = page.extract_text(layout=True) or ""
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
    NPTEL offer letter PDFs mein font rendering ki wajah se stray spaces
    aate hain. Do tarah ke artifacts hain:
      1) LETTER artifact: "P rof. Prabhjot" → "Prof. Prabhjot"
                          "I IT Roorkee"    → "IIT Roorkee"
      2) DIGIT artifact:  "1 2 weeks"       → "12 weeks"
                          "1 9-05-2026"     → "19-05-2026"

    Lekin "8 weeks" jaise valid space ko touch NAHI karna —
    isliye sirf specific patterns pe collapse karte hain.
    """
    v = v.strip()
    # 1) Letter-stray: "LETTER SPACE LETTER..." → drop the space at index 1
    if len(v) > 2 and v[0].isalpha() and v[1] == ' ' and v[2].isalpha():
        v = v[0] + v[2:]
    # 2) Digit-stray: "DIGIT SPACE DIGIT" → collapse the space
    #    (multi-digit numbers like "12" rendered as "1 2")
    v = re.sub(r'(\d) (\d)', r'\1\2', v)
    # Multi-spaces → single space
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


def extract_label_based(text: str) -> dict:
    """
    PURANA FORMAT — values labels ke saath inline hoti hain.
    Example:
      "Internship ID: SUM260130 Date: 18-05-2026"
      "Dear Abhinav Kumar Jha,"
      "1. Name of the Professor : Prof. Prabhjot Singh Chani"
    """
    return {
        "internship_id": no_spaces(find(r"Internship ID\s*:?\s*(.+?)\s*Date", text)),
        # "Dear Abhinav Kumar Jha," (old, with comma) ya
        # "Dear Abhishek Anand        " (new, no comma — ends with multi-spaces or newline)
        "name":          clean_stray(find(r"Dear\s+([A-Za-z][A-Za-z\s.]*?)(?:,|\s{2,}|\n|$)", text)),
        "professor":     clean_stray(find(r"Name of the Professor\s*:?\s*(.+)", text)),
        "institute":     clean_stray(find(r"offering Institute\s*:?\s*(.+)", text)),
        "mode":          clean_stray(find(r"Mode of internship\s*:?\s*(.+)", text)),
        "duration":      clean_stray(find(r"Duration of internship\s*:?\s*(.+)", text)),
        "start_date":    convert_date(no_spaces(find(r"Start date\s*:?\s*([\d -]+)", text))),
        "end_date":      convert_date(no_spaces(find(r"End date\s*:?\s*([\d -]+)", text))),
    }


def extract_offer_letter(pdf_path: str) -> dict:
    """
    Offer letter PDF se fields nikalo. layout=True (extract_text_from_pdf
    mein) dono format handle kar leta hai — purana (values inline) aur
    naya (fillable PDF jisme values labels pe overlay hoti hain).

    Returns: profile dict (mobile + default_login_time user dega website pe).
    """
    text = extract_text_from_pdf(pdf_path)
    profile = extract_label_based(text)
    profile['mobile'] = ''
    profile['default_login_time'] = '09:45'
    return profile


# Standalone test ke liye
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python extract_offer_letter.py <path-to-pdf>")
        sys.exit(1)

    result = extract_offer_letter(sys.argv[1])
    # indent=2 = sundar formatting, ensure_ascii=False = Indian naam sahi dikhe
    print(json.dumps(result, indent=2, ensure_ascii=False))
