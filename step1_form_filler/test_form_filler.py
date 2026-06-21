# =============================================================================
# FILE: test_form_filler.py
# PURPOSE: Test the form filler WITHOUT WhatsApp.
#          Run this first to verify Chrome automation works correctly.
#
# LEARNING CONCEPT: Test-First Development
#   Before connecting WhatsApp, you want to be 100% sure the form filler works.
#   This test file lets you try it in isolation.
#   Industry practice: always test components individually before integrating.
#
# HOW TO RUN:
#   python test_form_filler.py
#
# WHAT HAPPENS:
#   1. Chrome opens visibly
#   2. You watch it fill the form automatically
#   3. *** IT DOES NOT ACTUALLY SUBMIT *** (we stop before Submit to avoid spam)
#   4. Prints a success/fail report
# =============================================================================

import asyncio
import sys
import os

# Add parent of this file to Python path so we can import form_filler.py
# WHY: form_filler.py is in the same folder, but Python needs explicit path setup.
sys.path.insert(0, os.path.dirname(__file__))

from form_filler import fill_and_submit_form, load_user_profile, format_date_for_form, format_time_for_form

# =============================================================================
# UNIT TESTS — Test helper functions WITHOUT opening a browser
# These run instantly and tell you if your data formatting is correct.
# =============================================================================

def test_format_date():
    """Test that date formatting works correctly."""
    month, day, year = format_date_for_form("2026-05-19")
    assert month == "5",    f"Expected '5', got '{month}'"
    assert day   == "19",   f"Expected '19', got '{day}'"
    assert year  == "2026", f"Expected '2026', got '{year}'"
    print("PASS: test_format_date")


def test_format_time_am():
    """Test 24-hour to 12-hour conversion for AM times."""
    hr, minute, ampm = format_time_for_form("09:45")
    assert hr     == "9",    f"Expected '9', got '{hr}'"
    assert minute == "45",   f"Expected '45', got '{minute}'"
    assert ampm   == "AM",   f"Expected 'AM', got '{ampm}'"
    print("PASS: test_format_time_am")


def test_format_time_pm():
    """Test 24-hour to 12-hour conversion for PM times."""
    hr, minute, ampm = format_time_for_form("18:30")
    assert hr     == "6",    f"Expected '6', got '{hr}'"
    assert minute == "30",   f"Expected '30', got '{minute}'"
    assert ampm   == "PM",   f"Expected 'PM', got '{ampm}'"
    print("PASS: test_format_time_pm")


def test_format_time_midnight():
    """Test edge case: midnight (00:00) should be 12:00 AM."""
    hr, minute, ampm = format_time_for_form("00:00")
    assert hr   == "12",  f"Expected '12', got '{hr}'"
    assert ampm == "AM",  f"Expected 'AM', got '{ampm}'"
    print("PASS: test_format_time_midnight")


def test_load_profile():
    """Test that the user profile loads correctly from JSON."""
    profile_path = os.path.join(os.path.dirname(__file__), '..', 'users', 'SUM260130.json')
    profile = load_user_profile(profile_path)

    assert profile['name'] == "Abhinav Kumar Jha"
    assert profile['internship_id'] == "SUM260130"
    assert profile['duration'] == "12 weeks"
    print("PASS: test_load_profile")


# =============================================================================
# INTEGRATION TEST — Actually opens Chrome and fills the form
# Set ACTUALLY_SUBMIT = True ONLY when you're ready to test real submission.
# Keep it False during development to avoid submitting test data to the form.
# =============================================================================

ACTUALLY_SUBMIT = False  # ← CHANGE TO True when ready for real submission test

async def test_form_fill_visual():
    """
    Opens Chrome and fills the form with test data.
    If ACTUALLY_SUBMIT is False, it will fill everything but STOP before clicking Submit.
    """
    print("\n--- Starting Visual Browser Test ---")
    print(f"ACTUALLY_SUBMIT = {ACTUALLY_SUBMIT}")
    print("Watch Chrome — it should fill each field automatically.\n")

    if ACTUALLY_SUBMIT:
        # Full run including submission
        result = await fill_and_submit_form(
            nature_of_work="TEST SUBMISSION - Verifying automation pipeline",
            login_time="09:45",
            logout_time="17:00",
            headless=False
        )
        print("\n--- Result ---")
        print(f"Success: {result['success']}")
        print(f"Message: {result['message']}")
    else:
        # LEARNING NOTE: We import playwright here to run a partial test
        # (fill but don't submit). This shows you can use Playwright directly
        # for custom test scenarios too.
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=False, slow_mo=100)
            page = await browser.new_page()

            print("Opening form...")
            await page.goto(
                "https://docs.google.com/forms/d/e/1FAIpQLSc3hc_MvzVLMGxsC9Dwb8vH_W793qeBaX8M18jcC8Oqu3q8gw/viewform",
                wait_until='networkidle'
            )
            print("Form loaded. Watch Chrome fill the fields...")

            # Fill just the first few fields as a sanity check
            await page.get_by_label("Internship ID").fill("SUM260130")
            await page.get_by_label("Your Name").fill("Abhinav Kumar Jha")
            await page.get_by_label("Institute offering the internship").fill("IIT Roorkee")

            print("\nFields filled! (NOT submitting — ACTUALLY_SUBMIT is False)")
            print("Chrome will stay open for 5 seconds so you can inspect it...")

            # Keep browser open for 5 seconds so you can see the result
            await asyncio.sleep(5)
            await browser.close()
            print("Browser closed. Test complete.")


# =============================================================================
# RUN ALL TESTS
# =============================================================================

def run_unit_tests():
    """Run all unit tests (no browser needed)."""
    print("=" * 50)
    print("RUNNING UNIT TESTS")
    print("=" * 50)
    test_format_date()
    test_format_time_am()
    test_format_time_pm()
    test_format_time_midnight()
    test_load_profile()
    print("\nAll unit tests passed!\n")


if __name__ == "__main__":
    # Step 1: Run unit tests (fast, no browser)
    run_unit_tests()

    # Step 2: Run visual browser test (opens Chrome)
    asyncio.run(test_form_fill_visual())
