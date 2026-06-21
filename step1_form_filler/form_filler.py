# =============================================================================
# FILE: form_filler.py
# PURPOSE: Automatically fills and submits the NPTEL attendance Google Form
#          using Playwright — a library that controls a real Chrome browser.
#
# LEARNING CONCEPT: Browser Automation
#   Playwright lets your Python code control Chrome just like a human would.
#   It can open pages, click buttons, type text, select dropdowns, and submit.
#   Think of it as a robot sitting at the keyboard doing what you tell it.
#
# HOW TO RUN (for testing):
#   python form_filler.py
#
# HOW TO RUN (called by WhatsApp bot):
#   The WhatsApp bot (bot.js) calls this file with arguments:
#   python form_filler.py "Today I worked on data preprocessing" "10:30" "18:45"
# =============================================================================

# --- IMPORTS -----------------------------------------------------------------
# WHAT: We import the tools we need.
# WHY asyncio: Playwright is async — it doesn't block while waiting for the page.
#              Without async, your program would freeze until Chrome finishes loading.
import asyncio

# WHAT: datetime gives us today's date and current time.
# WHY: We need today's date to fill the start/end date fields,
#      and current time to set the logout time automatically.
from datetime import datetime

# WHAT: json lets us read .json files (like the user's profile).
# WHY: We store user data in a JSON file instead of hardcoding it,
#      so changing details doesn't require touching the code.
import json

# WHAT: sys gives access to command-line arguments.
# WHY: When the WhatsApp bot calls this script, it passes the work description
#      and optional login time as arguments. sys.argv captures those.
import sys

# WHAT: os lets us build file paths that work on any operating system.
# WHY: Windows uses backslash (\), Linux uses forward slash (/).
#      os.path.join() handles this automatically.
import os

# WHAT: logging records what happened to a file for debugging.
# WHY: If submission fails at 2am, you need to know WHAT went wrong without
#      sitting and watching the screen. Logs tell you the full story.
import logging

# WHAT: async_playwright is the main Playwright entry point.
# WHY: This is what lets us launch and control Chrome from Python.
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

# --- LOGGING SETUP -----------------------------------------------------------
# WHAT: Configure the logging system to write to both file and console.
# WHY: Console output lets you watch it live. File output lets you review later.
#      The format shows TIME - LEVEL - MESSAGE so you can trace exactly what happened.

# Build the path to the logs folder, relative to this file's location.
# __file__ = path to THIS script (form_filler.py)
# os.path.dirname() = the folder containing it (step1_form_filler/)
# os.path.join(..., '..', 'logs') = go up one folder, then into 'logs/'
LOG_FILE = os.path.join(os.path.dirname(__file__), '..', 'logs', 'submissions.log')

logging.basicConfig(
    level=logging.INFO,          # INFO level: logs INFO, WARNING, ERROR (not DEBUG noise)
    format='%(asctime)s - %(levelname)s - %(message)s',  # time + severity + message
    handlers=[
        logging.FileHandler(LOG_FILE),   # write to file
        logging.StreamHandler(sys.stdout) # also print to terminal
    ]
)

# Create a logger object for THIS file.
# WHY name it __name__? So logs show "form_filler" as the source, helpful when
# multiple files are logging at the same time.
logger = logging.getLogger(__name__)

# --- CONSTANTS ---------------------------------------------------------------
# WHAT: Fixed values that never change during execution.
# WHY constants, not magic strings? If the form URL changes, you update ONE line.
#     If it's scattered across 10 places, you'll miss one and have a hard-to-find bug.

# The Google Form URL — the page we will open in Chrome.
FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSc3hc_MvzVLMGxsC9Dwb8vH_W793qeBaX8M18jcC8Oqu3q8gw/viewform"

# Path to the user profile JSON (one level up, inside users/ folder).
# For now: single user. Later: we'll look up by phone number.
USER_PROFILE_PATH = os.path.join(os.path.dirname(__file__), '..', 'users', 'SUM260130.json')

# How long (in milliseconds) to wait for a page element before giving up.
# WHY 10 seconds? Google Forms can be slow on bad internet.
# If an element doesn't appear in 10s, something is wrong — fail fast, don't hang forever.
DEFAULT_TIMEOUT = 10_000  # 10,000 milliseconds = 10 seconds

# Dedicated Chrome profile folder.
# LEARNING CONCEPT: Persistent Browser Profile
#   Normally Playwright ek "fresh" Chrome kholta hai — koi login, cookie, history nahi.
#   Persistent profile = ek folder jahan Chrome apna login/cookies SAVE karta hai.
#   Pehli baar: tum is profile mein NPTEL Gmail se login karoge.
#   Uske baad: har baar Chrome khud-ba-khud usi Gmail se logged-in rahega.
#   Yeh folder tumhare normal Chrome se BILKUL ALAG hai — kuch kharab nahi hoga.
CHROME_PROFILE_DIR = os.path.join(os.path.dirname(__file__), 'chrome_profile')

# --- HELPER FUNCTIONS --------------------------------------------------------

def load_user_profile(profile_path: str) -> dict:
    """
    Reads the user's profile from a JSON file and returns it as a Python dictionary.

    LEARNING CONCEPT: Separation of Concerns
        The profile data lives in its own file (SUM260130.json).
        This function's ONLY job is to load it.
        If loading fails, it raises an error immediately rather than letting the
        program run with bad data and fail mysteriously later.

    Args:
        profile_path: absolute or relative path to the JSON file

    Returns:
        dict with keys: name, internship_id, institute, professor, mode, duration,
                        start_date, end_date, default_login_time

    Raises:
        FileNotFoundError: if the JSON file doesn't exist
        json.JSONDecodeError: if the JSON file has a syntax error
    """
    logger.info(f"Loading user profile from: {profile_path}")

    # WHAT: Open the file and parse the JSON inside it.
    # WHY 'r': 'r' means read-only. We never write to the profile here.
    # WHY utf-8: Indian names with special characters need UTF-8 encoding.
    with open(profile_path, 'r', encoding='utf-8') as f:
        profile = json.load(f)  # json.load() converts JSON text → Python dict

    logger.info(f"Profile loaded for: {profile['name']}")
    return profile


def get_current_time_str() -> str:
    """
    Returns the current time as a string in HH:MM format (24-hour).

    LEARNING CONCEPT: Why a helper function for something this simple?
        Because if you ever want to change the format (e.g., to 12-hour),
        you change it in ONE place. Also makes testing easier — you can
        mock (fake) this function in tests without changing the actual clock.

    Returns:
        str like "18:32" (6:32 PM in 24-hour format)
    """
    # datetime.now() = current date and time
    # .strftime("%H:%M") = format it as HH:MM (H=hour, M=minute)
    return datetime.now().strftime("%H:%M")


def format_date_for_form(date_str: str) -> tuple[str, str, str]:
    """
    Converts a date string from "YYYY-MM-DD" format into separate (month, day, year) strings
    that Google Form date pickers expect.

    LEARNING CONCEPT: Data Transformation
        External data (your JSON) stores dates as "2026-05-19" (ISO format — international standard).
        Google Forms date fields need month, day, year entered separately.
        This function bridges that gap — it's a data transformer.

    Args:
        date_str: "2026-05-19"

    Returns:
        tuple: ("5", "19", "2026")  ← month, day, year as strings (no leading zeros)

    Example:
        format_date_for_form("2026-05-19") → ("5", "19", "2026")
    """
    # strptime = "string parse time" — reads a string and creates a datetime object
    date_obj = datetime.strptime(date_str, "%Y-%m-%d")

    # Extract month, day, year individually.
    # str() converts int to string. No zero-padding because Google Forms
    # doesn't always accept "05" — plain "5" is safer.
    return str(date_obj.month), str(date_obj.day), str(date_obj.year)


def format_time_for_form(time_str: str) -> tuple[str, str, str]:
    """
    Converts "HH:MM" to (hour_12, minute, am_pm) for Google Form time pickers.

    Google Forms uses 12-hour format (1-12) with AM/PM.
    Your config stores 24-hour format ("09:45", "18:30").
    This function converts between them.

    Args:
        time_str: "09:45" or "18:30"

    Returns:
        tuple: ("9", "45", "AM") or ("6", "30", "PM")

    Example:
        format_time_for_form("09:45") → ("9", "45", "AM")
        format_time_for_form("18:30") → ("6", "30", "PM")
    """
    # Parse "HH:MM" into hour and minute integers
    hour, minute = map(int, time_str.split(':'))

    # Determine AM or PM
    am_pm = "AM" if hour < 12 else "PM"

    # Convert from 24-hour to 12-hour:
    # 0  → 12 (midnight)
    # 13 → 1  (1 PM)
    # 12 → 12 (noon, stays 12)
    if hour == 0:
        hour_12 = 12
    elif hour > 12:
        hour_12 = hour - 12
    else:
        hour_12 = hour

    return str(hour_12), str(minute).zfill(2), am_pm
    # .zfill(2) pads with zeros: 5 → "05" — Google Forms expects 2-digit minutes


# --- MAIN FORM FILLER FUNCTION -----------------------------------------------

async def fill_and_submit_form(
    nature_of_work: str,
    login_time: str = None,
    logout_time: str = None,
    headless: bool = False,
    submit: bool = False,
    keep_open: bool = True
) -> dict:
    """
    Opens Chrome, navigates to the Google Form, fills every field, and submits.

    LEARNING CONCEPT: async def
        This is an asynchronous function. When called, it doesn't block — other
        code can run while it's waiting for Chrome to load pages.
        You MUST use 'await' when calling it, like: await fill_and_submit_form(...)

    LEARNING CONCEPT: headless parameter
        headless=False → you SEE Chrome open and watch it fill the form (great for learning!)
        headless=True  → Chrome runs invisibly in background (for production/scheduled runs)

    Args:
        nature_of_work: the work description from WhatsApp message
        login_time:     "HH:MM" string, defaults to profile's default_login_time
        logout_time:    "HH:MM" string, defaults to current time
        headless:       whether to hide the browser window

    Returns:
        dict with keys:
            "success": True/False
            "message": human-readable result
            "timestamp": when the submission happened
    """
    # Load the user profile from disk.
    # WHAT HAPPENS NEXT: we'll use this data to fill each field.
    profile = load_user_profile(USER_PROFILE_PATH)

    # Apply defaults for optional parameters.
    # WHY check None (not just "if login_time")?
    # An empty string "" is also falsy — but it means the user sent a blank.
    # We only use the default if the value was truly not provided (None).
    if login_time is None:
        login_time = profile['default_login_time']
        logger.info(f"Using default login time: {login_time}")

    if logout_time is None:
        logout_time = get_current_time_str()
        logger.info(f"Using current time as logout: {logout_time}")

    logger.info(f"Starting form fill | Work: '{nature_of_work}' | Login: {login_time} | Logout: {logout_time}")

    # NOTE: Pehle hum dates/times ko todte the (format_date_for_form etc.), lekin
    # ab form NATIVE date input ("2026-05-19" seedha) aur 24-hour Hour/Minute box
    # use karta hai — toh todne ki zaroorat nahi. Values seedhe profile se jaati hain.

    # -------------------------------------------------------------------------
    # PLAYWRIGHT SECTION — This is where Chrome automation begins
    # -------------------------------------------------------------------------

    # WHAT: async_playwright() starts the Playwright engine.
    # WHY 'async with': it's a context manager — automatically cleans up when done.
    #                   Even if an error occurs, it closes the browser properly.
    #                   Without this, Chrome would stay open forever after a crash.
    async with async_playwright() as pw:

        # WHAT: launch_persistent_context — ek CHROME jo apna login yaad rakhta hai.
        # WHY persistent (normal launch nahi)?
        #   Normal launch har baar khaali Chrome deta hai (koi Gmail login nahi).
        #   Persistent context CHROME_PROFILE_DIR folder mein login save karta hai.
        #   Pehli baar tum NPTEL Gmail se login karoge, phir hamesha logged-in rahega.
        # WHY channel="chrome"? Asli Google Chrome use karta hai (Chromium nahi),
        #   taaki Google login normal lage aur block na ho.
        context = await pw.chromium.launch_persistent_context(
            CHROME_PROFILE_DIR,
            headless=headless,
            channel="chrome",   # asli Chrome (agar install nahi, to ye line hata dena)
            slow_mo=50,
            no_viewport=True,   # window apne natural size mein khule
            args=[
                "--start-maximized",
                "--no-first-run",              # "welcome to chrome" dialog skip
                "--no-default-browser-check",  # "make default?" prompt skip
            ]
        )
        logger.info("Browser launched (persistent profile)")

        # Persistent context mein pehle se ek blank tab hoti hai — wahi use karo.
        # Agar koi tab nahi, to nayi banao.
        page = context.pages[0] if context.pages else await context.new_page()
        page.set_default_timeout(DEFAULT_TIMEOUT)

        try:
            # -----------------------------------------------------------------
            # STEP 1: Open the form
            # -----------------------------------------------------------------

            logger.info(f"Navigating to form: {FORM_URL}")

            # WHAT: Tell Chrome to open the Google Form URL.
            # WHY wait_until='networkidle'?
            #     'load' = page HTML loaded (but JS may still be running)
            #     'networkidle' = ALL network requests finished (form fully rendered)
            #     Google Forms loads its fields via JavaScript AFTER the HTML —
            #     so we need networkidle to ensure the fields actually exist.
            await page.goto(FORM_URL, wait_until='networkidle')
            logger.info("Form page loaded")

            # -----------------------------------------------------------------
            # STEP 2: Fill text fields
            # -----------------------------------------------------------------
            # LEARNING CONCEPT: CSS Selectors and Input Names
            #   Every form field has an 'aria-label' or 'data-params' attribute.
            #   We use aria-label to find each field because it's the most stable
            #   (it's the visible label text, unlikely to change).
            #
            #   Syntax: page.get_by_label("Field Name")
            #   This finds the input whose label text matches exactly.

            # --- Internship ID ---
            logger.info("Filling: Internship ID")
            await page.get_by_label("Internship ID").fill(profile['internship_id'])
            # .fill() = clears the field first, then types the value.
            # WHY .fill() not .type()? .type() simulates keystrokes (slow).
            #     .fill() directly sets the value (fast, reliable).

            # --- Your Name ---
            logger.info("Filling: Name")
            await page.get_by_label("Your Name").fill(profile['name'])

            # --- Mobile Number ---
            # WHY fill mobile from profile? It's always the same — no need to ask user.
            logger.info("Filling: Mobile Number")
            await page.get_by_label("Mobile Number").fill(profile['mobile'])

            # --- Institute ---
            logger.info("Filling: Institute")
            await page.get_by_label("Institute offering the internship").fill(profile['institute'])

            # --- Professor Name ---
            logger.info("Filling: Professor")
            await page.get_by_label("Name of the Internship offering Professor").fill(profile['professor'])

            # -----------------------------------------------------------------
            # STEP 3: Fill the Dropdown — Mode of Internship
            # -----------------------------------------------------------------
            # LEARNING CONCEPT: Dropdowns in Google Forms
            #   Google Forms dropdowns are NOT native <select> elements.
            #   They're custom-built with divs and JavaScript.
            #   This means we can't use page.select_option() like a normal dropdown.
            #   Instead we: click the dropdown → wait for options to appear → click our option.

            logger.info("Selecting dropdown: Mode of Internship")

            # WHY THE OLD CODE FAILED:
            #   get_by_label("Mode of Internship").click() ne dropdown KHOLA hi nahi.
            #   Isliye "In-person" option DOM mein tha par VISIBLE nahi tha (dropdown band tha).
            #   Error: "element is not visible".
            #
            # NAYA TAREEKA (zyada reliable):
            #   1. Dropdown ka asli control = div[role="listbox"] — usse click karke kholo.
            #   2. Option ko data-value se dhoondo (error log mein dikha: data-value="In-person").
            #   3. Visible hone ka wait karke click karo.

            # Step 1: Dropdown kholo. Form mein sirf ek hi dropdown hai (Mode), isliye .first
            dropdown = page.get_by_role("listbox").first
            await dropdown.click()

            # Step 2: Option ko data-value attribute se exactly match karo.
            # WHY data-value? Yeh stable hai — Google ka text/class change ho sakta hai,
            # par data-value="In-person" wahi rehta hai.
            mode_option = page.locator(f'[role="option"][data-value="{profile["mode"]}"]')

            # Step 3: Visible hone tak wait karo, phir click.
            await mode_option.wait_for(state="visible", timeout=5000)
            await mode_option.click()

            logger.info(f"Selected mode: {profile['mode']}")

            # -----------------------------------------------------------------
            # STEP 4: Fill Radio Button — Duration of Internship
            # -----------------------------------------------------------------
            # LEARNING CONCEPT: Radio Buttons
            #   Radio buttons are <input type="radio"> elements.
            #   Only ONE can be selected at a time.
            #   We click the label text matching our duration.

            logger.info("Selecting radio: Duration of Internship")

            # get_by_label finds the radio button whose label matches "12 weeks".
            # .check() selects it (like clicking it, but also verifies it became checked).
            await page.get_by_label(profile['duration']).check()
            logger.info(f"Selected duration: {profile['duration']}")

            # -----------------------------------------------------------------
            # STEP 5: Fill Date Fields — Start and End Date
            # -----------------------------------------------------------------
            # LEARNING CONCEPT: Native HTML <input type="date">
            #   Screenshot se pata chala — yeh form NATIVE date input use karta hai
            #   (jo "dd-mm-yyyy" dikhata hai), 3 alag Month/Day/Year box NAHI.
            #
            #   Native date input mein value HAMESHA "YYYY-MM-DD" format mein bharo,
            #   chahe screen pe kuch bhi format dikhe. Browser khud convert kar leta hai.
            #   Hamare profile mein date pehle se "2026-05-19" format mein hai — perfect!
            #
            #   Form mein 2 date inputs hain (start, end). Hum unhe index se pakdenge:
            #   nth(0) = pehla (start), nth(1) = doosra (end).

            date_inputs = page.locator('input[type="date"]')

            logger.info("Filling: Internship start date")
            await date_inputs.nth(0).fill(profile['start_date'])  # "2026-05-19"

            logger.info("Filling: Internship end date")
            await date_inputs.nth(1).fill(profile['end_date'])    # "2026-08-10"

            # -----------------------------------------------------------------
            # STEP 6: Fill Time Fields — Login and Logout Time
            # -----------------------------------------------------------------
            # LEARNING CONCEPT: Google Forms time field = 2 alag text box
            #   Inspection se pata chala — time native input NAHI hai. Ye 2 alag
            #   text box hain: ek "Hour", ek "Minute" (aria-label se pehchaane jaate hain).
            #   Koi AM/PM dropdown nahi → 24-hour format. Toh 18:30 seedha daal sakte hain.
            #
            #   Form mein 2 time questions hain (login, logout), toh:
            #     "Hour"   box: nth(0)=login, nth(1)=logout
            #     "Minute" box: nth(0)=login, nth(1)=logout
            #
            #   login_time "09:45" ko ":" pe todo → hour="09", minute="45"

            login_h, login_m = login_time.split(':')    # "09:45" → "09", "45"
            logout_h, logout_m = logout_time.split(':')  # "18:30" → "18", "30"

            hour_boxes = page.get_by_label("Hour")      # dono Hour box
            minute_boxes = page.get_by_label("Minute")  # dono Minute box

            logger.info(f"Filling: Login time {login_time}")
            await hour_boxes.nth(0).fill(login_h)
            await minute_boxes.nth(0).fill(login_m)

            logger.info(f"Filling: Logout time {logout_time}")
            await hour_boxes.nth(1).fill(logout_h)
            await minute_boxes.nth(1).fill(logout_m)

            # -----------------------------------------------------------------
            # STEP 7: Fill Nature of Work
            # -----------------------------------------------------------------
            logger.info("Filling: Nature of work")
            await page.get_by_label("Write in one sentence the nature of work undertaken today").fill(nature_of_work)

            # -----------------------------------------------------------------
            # STEP 8: Form bhar diya — ab kya?
            # -----------------------------------------------------------------
            # IMPORTANT DESIGN DECISION:
            #   By default hum form SUBMIT NAHI karte. Kyun?
            #   - User khud Chrome mein review kare, kuch change karna ho to kare
            #     (jaise work description ya login time), phir KHUD submit dabaye.
            #   - Browser KHULA rehta hai taaki user ko poora control mile.
            #   submit=True sirf tab jab koi jaan-bujhke poora auto chahta ho (CLI --submit).

            # Bhare hue form ka screenshot (proof + bot WhatsApp pe bhej sakta hai)
            screenshot_path = os.path.join(
                os.path.dirname(__file__), '..', 'logs',
                f"filled_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            )
            await page.screenshot(path=screenshot_path, full_page=True)
            logger.info(f"Screenshot saved: {screenshot_path}")

            if not submit:
                # NORMAL FLOW: form bhar diya, submit NAHI kiya.
                logger.info("Form bhar diya — submit NAHI kiya. User khud submit karega.")

                # Ye special line bot.js padhega taaki turant WhatsApp pe bata sake.
                # flush=True => turant print ho (buffer mein atke nahi).
                print("FORMFILLER_STATUS: FILLED", flush=True)

                if keep_open:
                    # Browser KHULA rakho jab tak user khud window band na kare.
                    # wait_for_event('close') us waqt tak rukta hai jab tak browser band na ho.
                    # timeout=0 => koi time limit nahi (hamesha intezaar).
                    logger.info("Browser khula hai — user review/submit kar sakta hai.")
                    try:
                        await context.wait_for_event('close', timeout=0)
                    except Exception:
                        pass  # browser band ho gaya — theek hai

                return {
                    "success": True,
                    "message": "Form bhar diya — review karke khud submit karein.",
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "screenshot": screenshot_path
                }

            # --- submit=True hone par hi yahan tak aata hai (poora auto) ---
            logger.info("Clicking Submit button...")
            await page.get_by_role("button", name="Submit").click()

            logger.info("Waiting for confirmation page...")
            await page.wait_for_selector(
                'text=Your response has been recorded',
                timeout=15_000
            )
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            logger.info(f"SUBMISSION SUCCESSFUL at {timestamp}")
            await page.screenshot(path=screenshot_path, full_page=True)

            return {
                "success": True,
                "message": f"Attendance submitted successfully at {timestamp}",
                "timestamp": timestamp,
                "screenshot": screenshot_path
            }

        except PlaywrightTimeout as e:
            # LEARNING CONCEPT: Specific Exception Handling
            #   We catch PlaywrightTimeout SPECIFICALLY — not just "Exception".
            #   This tells us: "something took too long to appear on the page."
            #   Common cause: wrong selector, or the form changed its structure.
            error_msg = f"Timeout error — a field or page took too long to load. Details: {str(e)}"
            logger.error(error_msg)

            # Save a screenshot of what the page looks like when it failed.
            # WHY? So you can SEE what went wrong — was a field not found? page not loaded?
            error_screenshot = os.path.join(
                os.path.dirname(__file__), '..', 'logs',
                f"error_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
            )
            await page.screenshot(path=error_screenshot, full_page=True)

            return {
                "success": False,
                "message": error_msg,
                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "screenshot": error_screenshot
            }

        except Exception as e:
            # Catch any OTHER unexpected error (network error, element not found, etc.)
            error_msg = f"Unexpected error during form fill: {str(e)}"
            logger.error(error_msg)
            return {
                "success": False,
                "message": error_msg,
                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }

        finally:
            # LEARNING CONCEPT: finally block
            #   'finally' ka code HAMESHA chalta hai — error ho ya na ho.
            #
            #   Normal flow mein: keep_open=True hone par upar wala code browser band
            #   hone tak ruk gaya tha, toh context already band hai.
            #   Error flow mein: browser khula reh gaya — use band karna zaroori hai.
            #
            #   Persistent context mein context.browser None ho sakta hai, isliye
            #   seedha close() try karte hain aur error ignore karte hain
            #   (agar already band hai to error aayega — koi baat nahi).
            try:
                await context.close()
                logger.info("Browser closed")
            except Exception:
                pass  # already band tha — theek hai


# --- ENTRY POINT -------------------------------------------------------------
# LEARNING CONCEPT: if __name__ == "__main__"
#   Python sets __name__ = "__main__" when you run this file directly.
#   When another file imports this file, __name__ = "form_filler" (not "__main__").
#   This block runs ONLY when you run: python form_filler.py
#   It does NOT run when bot.js imports/calls this file.
#   This is the standard Python pattern for "run this if executed directly".

if __name__ == "__main__":
    # SAFETY DEFAULT: dry_run = True (form bharega par submit NAHI karega).
    #   Submit karne ke liye command mein "--submit" likhna zaroori hai.
    #   WHY? Official form hai. Galti se "python form_filler.py" chala diya
    #        to submit nahi hona chahiye. Submit JAAN-BUJHKE karna padega.
    #
    #   TEST karne ke liye (submit nahi):
    #       python form_filler.py "Aaj yeh kaam kiya"
    #   ASLI submit karne ke liye:
    #       python form_filler.py "Aaj yeh kaam kiya" --submit

    # --submit flag hai ya nahi? Agar hai to use args se hata do.
    args = sys.argv[1:]  # script name ke alawa baaki sab
    submit_mode = "--submit" in args
    if submit_mode:
        args.remove("--submit")  # taaki baaki parsing pe asar na pade

    if len(args) < 1:
        print("No work description — running with TEST DATA (DRY RUN, no submit)")
        nature_of_work = "Testing the automation pipeline - form fill verification"
        login_time = None
        logout_time = None
    else:
        nature_of_work = args[0]
        login_time  = args[1] if len(args) > 1 else None
        logout_time = args[2] if len(args) > 2 else None

    if submit_mode:
        print(">>> SUBMIT MODE — form ASLI mein submit hoga! <<<")
    else:
        print(">>> NORMAL MODE — form bharega, browser khula rahega, submit tum karoge <<<")

    # WHAT: asyncio.run() starts the async event loop and runs our async function.
    # WHY: async functions can't be called with just fill_and_submit_form().
    #      You need asyncio.run() to execute them from synchronous (normal) code.
    result = asyncio.run(fill_and_submit_form(
        nature_of_work=nature_of_work,
        login_time=login_time,
        logout_time=logout_time,
        headless=False,          # False = browser dikhega
        submit=submit_mode,      # --submit diya to hi auto-submit
        keep_open=not submit_mode  # normal mode mein browser khula chhodo
    ))

    # Print the final result so the caller (bot.js) can read it.
    print(json.dumps(result, indent=2))
    # WHY json.dumps? When bot.js calls this Python script, it reads stdout.
    # JSON is the standard format for passing structured data between programs.
