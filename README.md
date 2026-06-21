# NPTEL Attendance Automation — Learning Guide

## What This Project Does
You send a WhatsApp message with your work description.
The bot reads it, fills the Google Form with your profile + today's timestamps, and submits it.

## How To Learn From This Project
Every file has comments explaining:
- WHAT the line does (the code itself)
- WHY it exists (the design decision)
- WHAT HAPPENS NEXT (the flow)

---

## Project Structure (read this first — understand before you code)

```
Attendance/
│
├── config.json              ← YOUR profile data (fixed fields)
├── users/
│   └── SUM260130.json       ← same as config.json but named by internship ID (for future scaling)
│
├── step1_form_filler/
│   ├── form_filler.py       ← CORE: fills and submits the Google Form using Playwright
│   └── test_form_filler.py  ← TEST: run this to verify form filling works
│
├── step2_whatsapp_bot/
│   ├── bot.js               ← listens to WhatsApp, triggers Python form filler
│   └── package.json         ← Node.js dependencies
│
├── step3_state_machine/
│   └── session.js           ← manages conversation state per user (IDLE → CONFIRM → SUBMIT)
│
├── step4_web_onboarding/    ← (Phase 2, for 10 users)
│   ├── app.py               ← Flask web server for new user registration
│   └── templates/
│       └── register.html    ← simple form for new users to enter their details
│
└── logs/
    └── submissions.log      ← every submission attempt recorded here
```

---

## Build Order (do NOT skip steps — each builds on the previous)

| Step | What You Build | What You Learn |
|------|----------------|----------------|
| 1 | `form_filler.py` | Playwright, browser automation, form interaction |
| 2 | `bot.js` | WhatsApp Web JS, event listeners, async JS |
| 3 | `session.js` | State machines, conversation design |
| 4 | `app.py` (onboarding) | Flask, JSON storage, scaling patterns |

---

## Prerequisites — Install These First

```bash
# Python dependencies (for form filler)
pip install playwright
playwright install chromium    # downloads the browser

# Node.js dependencies (for WhatsApp bot)
npm install whatsapp-web.js qrcode-terminal
```

---

## Key Concepts You Will Learn

### 1. Browser Automation
Playwright controls Chrome like a human — it clicks, types, selects dropdowns.
You write code that says "find this element → click it → type this text".

### 2. Selectors
How does code find a field on a webpage?
Using CSS selectors or input names — the same way browser DevTools work.

### 3. Async Programming
Both Python (async/await) and JavaScript (async/await) are used here.
Async means: "start this task, don't block, move on, come back when done."

### 4. State Machines
A user's conversation is always in ONE state at a time.
The bot behaves differently depending on the current state.

### 5. Event-Driven Architecture
The WhatsApp bot doesn't run in a loop checking for messages.
It LISTENS and reacts when an event (new message) fires.
