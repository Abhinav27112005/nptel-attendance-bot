// =============================================================================
// FILE: bot.js
// PURPOSE: WhatsApp bot that listens for messages and triggers the form filler.
//
// LEARNING CONCEPT: Event-Driven Architecture
//   This bot does NOT run in a loop checking "any new messages?"
//   Instead it LISTENS — when WhatsApp delivers a message, an event fires,
//   and our callback function runs. This is far more efficient.
//   Think of it like: instead of checking your mailbox every minute,
//   you have a notification bell that rings when mail arrives.
//
// LEARNING CONCEPT: Node.js vs Python
//   We use Node.js here (not Python) because whatsapp-web.js is a Node library.
//   The WhatsApp bot (JS) calls the form filler (Python) as a child process.
//   Two languages, two responsibilities, one pipeline.
//
// HOW TO RUN:
//   node bot.js
//   First run: a QR code appears in terminal — scan it with WhatsApp to link account.
//
// FLOW:
//   1. Bot starts, shows QR code
//   2. You scan with WhatsApp (links your account)
//   3. Bot is now live — it can receive messages
//   4. You send a message from your OWN number to yourself (Saved Messages)
//      OR from any number you define as "authorized"
//   5. Bot receives message → triggers Python form filler
//   6. Bot sends confirmation reply
// =============================================================================

// --- IMPORTS -----------------------------------------------------------------

// WHAT: whatsapp-web.js is the library that lets Node.js control WhatsApp Web.
// WHY: It uses Puppeteer (a headless browser) to run WhatsApp Web in the background,
//      intercepts messages, and exposes them as JavaScript events.
// HOW IT WORKS: It opens WhatsApp Web in a hidden browser, simulates being logged in,
//               and fires events when things happen (new message, QR code generated, etc.)
const { Client, LocalAuth } = require('whatsapp-web.js');

// WHAT: qrcode-terminal renders a QR code as ASCII art in your terminal.
// WHY: On first run, WhatsApp requires a QR scan to link your account.
//      This library prints that QR code directly in the terminal so you can scan it.
const qrcode = require('qrcode-terminal');

// WHAT: child_process lets Node.js run external programs (like our Python script).
// WHY: The form filler is written in Python. Node can't run Python directly,
//      but it can SPAWN a Python process, wait for it to finish, and read its output.
// spawn = launch a process and stream its output in real-time
// exec  = launch a process, wait for it to finish, get all output at once
const { spawn } = require('child_process');

// WHAT: path helps build file paths that work on Windows and Mac/Linux.
// WHY: Windows uses C:\Users\... but Mac/Linux use /home/user/...
//      path.join() automatically uses the right separator for your OS.
const path = require('path');

// WHAT: fs (file system) lets us read and write files.
// WHY: We read user profiles from JSON files to check if a sender is authorized.
const fs = require('fs');

// WHAT: reminder.js se reminder functions import kar rahe hain.
// WHY: Shaam 5 baje ke baad reminder bhejne aur "aaj bhar di" track karne ke liye.
const { startReminders, markSubmittedToday } = require('./reminder');

// WHAT: prefill.js se pre-filled Google Form link banane wala function.
// WHY: Bot ab Chrome nahi kholega — bas bhara-bharaya link bhejega jo user
//      apne mobile pe tap karke submit karega.
const { buildPrefilledUrl } = require('./prefill');

// WHAT: db.js — data layer. Users MongoDB (cloud) ya local files se aate hain.
// WHY: Multi-user + Render deployment ke liye. .env ke MONGODB_URI pe depend karta hai.
const db = require('./db');

// --- CONFIGURATION -----------------------------------------------------------
// WHAT: Central config object for bot behavior.
// WHY single object? If settings are scattered across the file, you forget where to change them.
//     Keeping them here means one place to look.

const BOT_CONFIG = {
    // Path to the Python form filler script
    // __dirname = the folder where THIS file (bot.js) lives
    // We go up one level (..) then into step1_form_filler/
    FORM_FILLER_SCRIPT: path.join(__dirname, '..', 'step1_form_filler', 'form_filler.py'),

    // Path to the users folder
    USERS_DIR: path.join(__dirname, '..', 'users'),

    // The "trigger phrase" prefix — messages starting with this will trigger attendance.
    // WHY a trigger? So normal WhatsApp conversations don't accidentally trigger the bot.
    // The user sends: "attend: Worked on data preprocessing today"
    // TRIGGER_PREFIX: 'attend:',   ← with trigger prefix (safer for groups)
    // For personal use, any message triggers it. We'll use a simple approach:
    // If the message is from YOU and doesn't start with !, it's a work description.
    TRIGGER_PREFIX: null,  // null = any message from authorized numbers triggers it

    // Special command prefix — messages starting with this are bot commands, not work descriptions.
    COMMAND_PREFIX: '!',

    // Registration website ka URL — naya user "REGISTER" bhejega to ye link milega.
    // Render pe deployed (hamesha online, dost ke phone se bhi khulega).
    REGISTER_URL: 'https://nptel-attendance-bot.onrender.com',

    // Short link ka base URL — yeh + "/r/" + short_id. WhatsApp pe full
    // Google Forms URL ki jagah ye chhota link bhejte hain (security/clean).
    SHORT_BASE: 'https://nptel-attendance-bot.onrender.com',

    // Your WhatsApp number with country code (no + or spaces)
    // PHASE 1 (single user): only this number can trigger the bot.
    // PHASE 2 (multi-user): we'll check the users/ folder instead.
    AUTHORIZED_NUMBER: '919835262809@c.us',
    // WhatsApp internally appends @c.us to every contact ID.
    // msg.from always arrives as "919835262809@c.us" — must match exactly.
};

// --- SESSION STATE -----------------------------------------------------------
// LEARNING CONCEPT: State Machine
//   Each user's conversation is always in ONE state.
//   The bot behaves DIFFERENTLY depending on current state.
//
//   States:
//   IDLE          → waiting for a work description message
//   AWAITING_CONFIRM → showed summary, waiting for "YES" or "LOGIN HH:MM"
//   SUBMITTING    → currently running the form filler (don't accept new commands)

// WHY a Map (not a plain object)?
// Map.get(key) returns undefined for missing keys (safe).
// Object[key] can accidentally match inherited properties like 'constructor'.
// Map is the correct data structure for key-value lookups with dynamic keys.
const userSessions = new Map();
// Structure of each session:
// {
//     state: 'IDLE' | 'AWAITING_CONFIRM' | 'SUBMITTING',
//     pendingData: {           // data waiting for confirmation
//         natureOfWork: string,
//         loginTime: string,
//         logoutTime: string,
//         messageTimestamp: Date
//     }
// }

// --- HELPER FUNCTIONS --------------------------------------------------------

/**
 * Message se user ka profile dhoondho.
 *
 * IMPORTANT: msg.from kabhi @c.us hota hai (mobile number visible) aur kabhi
 *   @lid (WhatsApp ki internal device ID — phone number NAHI). Newer accounts
 *   mostly @lid se aate hain aur WhatsApp Web API se phone resolve karna
 *   reliably nahi hota.
 *
 *   db.getUserByMobile() dono check karta hai:
 *     - whatsapp_id field (full @c.us / @lid)
 *     - mobile field (phone digits, @c.us se nikal ke)
 *
 *   @lid users ke liye whatsapp_id DB mein "LINK <internship_id>" command
 *   ke baad save hoti hai (ek-baar ka onboarding step).
 */
async function findUserByMessage(msg) {
    const profile = await db.getUserByMobile(msg.from);
    return { profile, whatsappId: msg.from };
}

/**
 * Gets or creates a session for a user.
 * Every user starts in IDLE state if they have no session yet.
 *
 * @param {string} userId - WhatsApp ID
 * @returns {object} session object
 */
function getSession(userId) {
    if (!userSessions.has(userId)) {
        // New user — create a fresh IDLE session
        userSessions.set(userId, {
            state: 'IDLE',
            pendingData: null
        });
    }
    return userSessions.get(userId);
}

/**
 * "09:45" (24-hour) → "09:45 AM" (12-hour with AM/PM, clarity ke liye).
 */
function to12Hour(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return `${String(h12).padStart(2,'0')}:${String(m).padStart(2,'0')} ${ampm}`;
}

/**
 * Sanity check — galat lagne wala time ho to warning return karo.
 * - Login generally AM hota hai (subah ya dopahar tak)
 * - Logout generally PM hota hai (shaam ko)
 * - Late-night testing ya odd timing pe user ko alert karta hai
 */
function timeWarnings(loginTime, logoutTime) {
    const warns = [];
    const lh = parseInt(loginTime.split(':')[0], 10);
    const oh = parseInt(logoutTime.split(':')[0], 10);
    if (lh >= 12) warns.push(`⚠️ Login time looks like PM (${to12Hour(loginTime)}) — is that right?`);
    if (oh < 8)   warns.push(`⚠️ Logout time is very early (${to12Hour(logoutTime)}) — is that right?`);
    return warns;
}

/**
 * Formats a summary message showing what will be submitted.
 */
function formatSummaryMessage(profile, pendingData) {
    const loginDisplay  = `${pendingData.loginTime}  (${to12Hour(pendingData.loginTime)})`;
    const logoutDisplay = `${pendingData.logoutTime}  (${to12Hour(pendingData.logoutTime)})`;
    const warns = timeWarnings(pendingData.loginTime, pendingData.logoutTime);
    const warnBlock = warns.length ? '\n' + warns.join('\n') + '\n' : '';

    return `📋 *Attendance Summary*
─────────────────────
👤 Name: ${profile.name}
🆔 ID: ${profile.internship_id}
🏛️ Institute: ${profile.institute}
👨‍🏫 Professor: ${profile.professor}
💻 Mode: ${profile.mode}
📅 Duration: ${profile.duration}
📆 Start Date: ${profile.start_date}
📆 End Date: ${profile.end_date}
🕐 Login Time: ${loginDisplay}
🕕 Logout Time: ${logoutDisplay}
📝 Work Done: ${pendingData.natureOfWork}${warnBlock}
─────────────────────
✅ Send *YES* → get your pre-filled form link
🕐 Send *LOGIN HH:MM* → change login time (e.g. LOGIN 10:30)
❌ Send *CANCEL* → discard`;
}

/**
 * Calls the Python form filler script and returns the result.
 *
 * LEARNING CONCEPT: Child Process Communication
 *   Node.js runs Python as a "child process" — a separate program.
 *   They communicate via:
 *   - STDIN:  Node → Python (we don't use this here)
 *   - STDOUT: Python → Node (we read the JSON result this way)
 *   - STDERR: Python error messages (we log these)
 *   - Exit code: 0 = success, non-zero = error
 *
 * @param {string} natureOfWork
 * @param {string} loginTime  - "HH:MM"
 * @param {string} logoutTime - "HH:MM"
 * @returns {Promise<object>} - the JSON result from Python
 */
function runFormFiller(natureOfWork, loginTime, logoutTime) {
    // Return a Promise — result LATER milega (async).
    //
    // NAYA BEHAVIOUR (important):
    //   Pehle hum process EXIT hone ka wait karte the. Lekin ab Python form bhar ke
    //   browser KHULA chhod deta hai (user khud submit karega) — toh process turant
    //   exit NAHI hota, browser band hone tak chalta rehta hai.
    //
    //   Isliye hum ab ek SPECIAL LINE ka wait karte hain jo Python print karta hai:
    //   "FORMFILLER_STATUS: FILLED". Ye line aate hi samajh jaate hain form bhar gaya,
    //   aur WhatsApp pe turant bata dete hain — process ko background mein chalne dete hain.
    return new Promise((resolve, reject) => {
        console.log(`[FormFiller] Starting Python script...`);
        console.log(`[FormFiller] Args: "${natureOfWork}" "${loginTime}" "${logoutTime}"`);

        const pythonProcess = spawn('python', [
            BOT_CONFIG.FORM_FILLER_SCRIPT,
            natureOfWork,
            loginTime,
            logoutTime
        ]);

        let outputData = '';
        let settled = false;  // ek hi baar resolve/reject ho — double na ho

        pythonProcess.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            outputData += text;
            console.log(`[Python] ${text.trim()}`);  // live dekho kya ho raha hai

            // Special marker mila? Matlab form bhar gaya.
            if (!settled && text.includes('FORMFILLER_STATUS: FILLED')) {
                settled = true;
                resolve({
                    success: true,
                    message: 'Form bhar diya — Chrome khula hai, review karke submit karein.'
                });
                // Process ko KILL nahi karte — browser khula rehne dena hai.
            }
        });

        pythonProcess.stderr.on('data', (chunk) => {
            console.error(`[Python stderr] ${chunk.toString()}`);
        });

        // Agar process bina FILLED bole hi band ho gaya → kuch gadbad hui.
        pythonProcess.on('close', (exitCode) => {
            console.log(`[FormFiller] Python process exited with code: ${exitCode}`);
            if (!settled) {
                settled = true;
                // Error JSON dhoondo Python output mein
                let msg = `Form fill fail hua (exit code ${exitCode}).`;
                try {
                    const jsonLine = outputData.trim().split('\n').filter(l => l.startsWith('{')).pop();
                    if (jsonLine) msg = JSON.parse(jsonLine).message || msg;
                } catch (e) { /* ignore */ }
                reject(new Error(msg));
            }
        });

        pythonProcess.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(new Error(`Python process start nahi hua: ${err.message}`));
            }
        });
    });
}

// WhatsApp gives every account TWO identifiers:
//   @c.us  → phone number based:  "919835262809@c.us"
//   @lid   → device/local ID:     "243323184902311@lid"
// Messages you send to yourself arrive with the @lid format.
// We capture BOTH on startup and check against either in auth.
let MY_WHATSAPP_ID = null;  // phone-based @c.us
let MY_LID = null;          // device-based @lid

// --- BOT SETUP ---------------------------------------------------------------
// LEARNING CONCEPT: LocalAuth
//   On first run, you scan a QR code. WhatsApp creates a session.
//   LocalAuth saves this session to disk so you DON'T need to scan QR again
//   every time you restart the bot.
//   Without LocalAuth: scan QR every restart (annoying).
//   With LocalAuth: scan once, session persists.

const client = new Client({
    authStrategy: new LocalAuth({
        // Session data stored in this folder.
        // Each restart reads from here — no new QR needed.
        dataPath: path.join(__dirname, '.wwebjs_auth')
    }),
    puppeteer: {
        // headless: true = WhatsApp Web browser runs invisibly.
        // WHY: We don't need to SEE this browser — it just handles the connection.
        // The FORM FILLER browser (headless:false) is the one we want to see.
        headless: true,
        args: ['--no-sandbox'] // Required on some Linux servers
    }
});

// --- BOT EVENTS --------------------------------------------------------------
// LEARNING CONCEPT: Event Listeners
//   .on('event_name', callback) registers a function to call when that event fires.
//   This is the core pattern of event-driven programming.

// EVENT: qr
// WHEN: Client needs authentication (first run, or session expired)
// WHAT: Displays the QR code in terminal for you to scan
client.on('qr', (qr) => {
    console.log('\n📱 Scan this QR code with WhatsApp to log in:\n');
    // qrcode.generate() renders the QR as ASCII art in the terminal
    qrcode.generate(qr, { small: true });
    console.log('\nOpen WhatsApp → Settings → Linked Devices → Link a Device\n');
});

// EVENT: ready
// WHEN: Client is connected and ready to receive messages
client.on('ready', async () => {
    // Capture phone-based ID (@c.us)
    MY_WHATSAPP_ID = client.info.wid._serialized;

    // Capture device-based ID (@lid) via WhatsApp's internal JS store.
    // WHY pupPage.evaluate()? The @lid lives inside WhatsApp Web's JavaScript
    // memory (window.Store.Me). Playwright/Puppeteer lets us run JS inside
    // that browser page and read values from it.
    try {
        MY_LID = await client.pupPage.evaluate(() => {
            return window.Store?.Me?.lid?._serialized || null;
        });
    } catch (e) {
        console.log('Could not fetch @lid (non-critical):', e.message);
    }

    console.log(`\n✅ WhatsApp bot is ready!`);
    console.log(`🪪 Phone ID : ${MY_WHATSAPP_ID}`);
    console.log(`🪪 Device ID: ${MY_LID}`);
    console.log('📨 Send a message to trigger attendance filling.');
    console.log('Commands:');
    console.log('  !help  → show this help');
    console.log('  !status → check bot status');
    console.log('  Any other message → fill attendance form\n');

    // DB connect karo (cloud mode mein) — startup pe ek baar.
    await db.connect();
    console.log(`[DB] Mode: ${db.usingCloud() ? 'MongoDB (cloud)' : 'local files'}`);

    // Reminder scheduler — async getTargets fetches all registered users from DB.
    // Prefer whatsapp_id (the actual @lid/@c.us the user messages from) so the
    // reminder reaches them even on @lid-only accounts. Fall back to mobile@c.us.
    startReminders(client, async () => {
        const users = await db.getAllUsers();
        return users
            .filter(p => p && p.internship_id)
            .map(p => ({
                id: p.whatsapp_id || `${(p.mobile || '').replace(/[+\s]/g, '')}@c.us`,
                name: p.name || p.internship_id,
                internshipId: p.internship_id
            }))
            .filter(t => t.id);  // drop ones with no usable id
    });
});

// EVENT: auth_failure
// WHEN: Authentication fails (QR scan failed or session corrupted)
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    console.log('Delete the .wwebjs_auth folder and restart to re-scan QR');
});

// EVENT: disconnected
// WHEN: WhatsApp disconnects (phone offline, internet lost, etc.)
client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp disconnected:', reason);
    console.log('🔄 Reconnecting in 5 seconds...');
    setTimeout(() => client.initialize(), 5000);
});

// --- MAIN MESSAGE HANDLER ---------------------------------------------------
// EVENT: message
// WHEN: ANY message is received (from any chat, any sender)
// WHY async: We use 'await' inside, so the handler must be async.

// LEARNING CONCEPT: message vs message_create
//   'message'        → fires when someone ELSE sends you a message
//   'message_create' → fires for ALL messages including ones YOU send
//   When you message yourself (Saved Messages), YOU are the sender.
//   So 'message' never fires — only 'message_create' does.
//   We handle both events by pointing them to the same handler function.

// Track message IDs that the BOT itself sent, so we don't react to our own replies.
// WHY a Set? message_create fires for EVERY outgoing message including bot replies.
// Without this, the bot would see its own reply → trigger again → infinite loop.
const botSentIds = new Set();

/**
 * Send a reply and record its ID so the bot ignores it when message_create fires.
 * Use this everywhere instead of msg.reply() directly.
 */
async function botReply(msg, text) {
    const sent = await msg.reply(text);
    if (sent?.id?._serialized) {
        botSentIds.add(sent.id._serialized);
    }
    return sent;
}

// DEDUPE: WhatsApp Web @lid contacts ke liye DONO 'message' aur 'message_create'
// events fire hote hain (self-messages mein sirf ek). Same message ki ID dobara
// aaye to skip karo, warna har reply 2 baar bheji jaayegi.
const processedMessageIds = new Set();
function alreadyProcessed(msg) {
    const id = msg?.id?._serialized;
    if (!id) return false;
    if (processedMessageIds.has(id)) return true;
    processedMessageIds.add(id);
    // Memory cap — sirf last 500 IDs yaad rakho
    if (processedMessageIds.size > 500) {
        const arr = [...processedMessageIds];
        arr.slice(0, 250).forEach(i => processedMessageIds.delete(i));
    }
    return false;
}

async function handleMessage(msg) {
    // Pehla check: yeh message pehle process ho chuka? (dual-event dedup)
    if (alreadyProcessed(msg)) return;

    // Capture our own @lid from the first self-message we see.
    // WHY: window.Store.Me.lid is null in this whatsapp-web.js version,
    //      but msg.to on a self-message contains our @lid — so we grab it here.
    if (msg.fromMe && msg.to && msg.to.endsWith('@lid') && !MY_LID) {
        MY_LID = msg.to;
        console.log(`[Debug] Captured own @lid: ${MY_LID}`);
    }

    const senderId = msg.from;

    const messageBody = msg.body.trim();
    const messageTime = new Date();

    // Log every incoming message for debugging.
    console.log(`[${messageTime.toISOString()}] Message from ${senderId}: "${messageBody}"`);

    // ---------------------------------------------------------
    // GATE 1: Bot ke apne replies ignore karo
    //   Bot ke reply @lid se aate hain. Unpe react kiya to infinite loop.
    // ---------------------------------------------------------
    if (MY_LID && msg.from === MY_LID) {
        return;  // apna hi reply — chhodo
    }

    // ---------------------------------------------------------
    // REGISTER: naya user "REGISTER" bheje → registration site ka link do.
    //   Agar PEHLE SE registered hai → bata do, dobara karne ki zaroorat nahi.
    //   trim + toUpperCase taaki "register", "Register", " REGISTER " sab chale.
    // ---------------------------------------------------------
    // ---------------------------------------------------------
    // COMMAND DETECTION — strict! Sirf in commands pe react karenge:
    //   REGISTER, LINK <id>, WORK: ..., YES, CANCEL, LOGIN HH:MM, !help, !status
    // Baaki SAB silent ignore (personal baatein, normal chat, kuch nahi).
    // ---------------------------------------------------------
    const trimmed = messageBody.trim();
    const upper   = trimmed.toUpperCase();

    const isRegister = upper === 'REGISTER';
    const linkMatch  = trimmed.match(/^LINK\s+([A-Z0-9]+)$/i);  // "LINK SUM260111"
    const workMatch  = trimmed.match(/^WORK:\s*(.+)/is);
    const isYes      = upper === 'YES';
    const isCancel   = upper === 'CANCEL';
    const loginMatch = trimmed.match(/^LOGIN\s+(\d{1,2}:\d{2})$/i);
    const isBangCmd  = trimmed.startsWith('!') && /^!(help|status)$/i.test(trimmed);

    // Recognized command hai ya nahi?
    const isCommand = isRegister || linkMatch || workMatch || isYes || isCancel || loginMatch || isBangCmd;
    if (!isCommand) {
        // Normal chat / casual message — bilkul chup. Privacy + no spam.
        return;
    }

    // ---------------------------------------------------------
    // REGISTER — pehle se registered? bata do. Naya? site ka link.
    // ---------------------------------------------------------
    if (isRegister) {
        const { profile: existing } = await findUserByMessage(msg);
        if (existing) {
            await botReply(msg,
                `✅ *You're already registered!*\n\n` +
                `👤 Name: ${existing.name}\n` +
                `🆔 ID: ${existing.internship_id}\n\n` +
                `To mark attendance, just send: *WORK: <what you did today>*\n\n` +
                `_To update details: ${BOT_CONFIG.REGISTER_URL}_`
            );
        } else {
            await botReply(msg,
                `📝 *NPTEL Attendance Bot — Registration*\n\n` +
                `*Step 1:* Open the link below and upload your *offer letter PDF*. All details will be extracted automatically.\n\n` +
                `👉 ${BOT_CONFIG.REGISTER_URL}\n\n` +
                `*Step 2:* After registering on the website, tap the green *"Verify on WhatsApp"* button that appears. It will open WhatsApp with the LINK command pre-filled — just hit Send.\n\n` +
                `*Step 3:* Now you can mark attendance by sending: *WORK: <your work today>*`
            );
        }
        return;
    }

    // ---------------------------------------------------------
    // LINK <internship_id> — connect WhatsApp account to registered profile.
    //   Needed because WhatsApp Web doesn't reliably resolve @lid → phone,
    //   so the user explicitly tells the bot their ID. The "Verify on
    //   WhatsApp" button on the website pre-fills this command — most
    //   users never type it manually.
    // ---------------------------------------------------------
    if (linkMatch) {
        const internshipId = linkMatch[1].toUpperCase();

        // Already linked?
        const { profile: existing } = await findUserByMessage(msg);
        if (existing) {
            await botReply(msg,
                `✅ Already linked!\n👤 ${existing.name} (${existing.internship_id})`
            );
            return;
        }

        // Find profile by ID, then save this WhatsApp ID into it.
        const linked = await db.linkWhatsappId(internshipId, msg.from);
        if (!linked) {
            await botReply(msg,
                `❌ Internship ID *${internshipId}* not found.\n\n` +
                `Please register first: ${BOT_CONFIG.REGISTER_URL}\n` +
                `Then come back and send *LINK ${internshipId}* again.`
            );
            return;
        }

        const { profile: verifyProfile } = await findUserByMessage(msg);
        await botReply(msg,
            `✅ *Account linked!*\n\n` +
            `👤 ${verifyProfile?.name || '(name not set)'}\n` +
            `🆔 ${internshipId}\n\n` +
            `Now you can mark attendance by sending: *WORK: <what you did today>*`
        );
        return;
    }

    // ---------------------------------------------------------
    // Iske aage saare commands ke liye REGISTRATION zaroori
    // Registered nahi? → silent ignore. User REGISTER bhejega to upar link mil jata hai.
    // ---------------------------------------------------------
    const { profile } = await findUserByMessage(msg);

    if (!profile) {
        console.log(`[Auth] Unregistered (from=${senderId}) — silent`);
        return;
    }
    console.log(`[Auth] ${profile.name} — processing`);

    const session = getSession(senderId);

    // ---------------------------------------------------------
    // !help / !status
    // ---------------------------------------------------------
    if (isBangCmd) {
        const cmd = trimmed.slice(1).toLowerCase();
        if (cmd === 'help') {
            await botReply(msg,
                `*NPTEL Attendance Bot — Commands* 🤖\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `📝 *WORK:* <what you did today>\n` +
                `   _Start attendance flow._\n` +
                `   Example: \`WORK: Worked on data scraping today\`\n\n` +
                `✅ *YES* — confirm and get your form link\n` +
                `❌ *CANCEL* — discard\n` +
                `🕐 *LOGIN HH:MM* — change login time (e.g. \`LOGIN 10:30\`)\n\n` +
                `🔵 *REGISTER* — registration link\n` +
                `🟢 *!status* — your status (how many links today)\n` +
                `🟡 *!help* — this message`
            );
        } else {
            // !status — registered status + today's link count + last link time
            let countLine = '🔢 Links today: *0*';
            let lastLine = '';
            try {
                const s = await db.getLinkStats(profile.internship_id);
                if (s) {
                    countLine = `🔢 Links today: *${s.count}*`;
                    if (s.last_at) {
                        const lastAt = new Date(s.last_at);
                        const hh = String(lastAt.getHours()).padStart(2, '0');
                        const mm = String(lastAt.getMinutes()).padStart(2, '0');
                        lastLine = `\n⏰ Last link: *${hh}:${mm}*`;
                    }
                }
            } catch (e) { /* ignore stats fail */ }

            const hint = countLine.includes('*0*')
                ? '_No attendance link generated today yet — send `WORK: ...` to start._'
                : `_Link already sent — open it and submit to mark attendance._`;

            await botReply(msg,
                `📊 *Your Status*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🟢 Status: *Registered*\n` +
                `👤 Name: ${profile.name}\n` +
                `🆔 ID: ${profile.internship_id}\n\n` +
                `${countLine}${lastLine}\n\n` +
                `${hint}`
            );
        }
        return;
    }

    // ---------------------------------------------------------
    // STATE MACHINE — current state ke hisaab se message handle karo
    // (session aur profile upar already nikal liye hain)
    // ---------------------------------------------------------

    // ---------------------------------------------------------
    // WORK: <description>  →  summary aur YES ka intezaar
    // ---------------------------------------------------------
    if (workMatch) {
        const natureOfWork = workMatch[1].trim();
        const logoutTime = `${String(messageTime.getHours()).padStart(2, '0')}:${String(messageTime.getMinutes()).padStart(2, '0')}`;
        session.pendingData = {
            natureOfWork,
            loginTime: profile.default_login_time,
            logoutTime
        };
        session.state = 'AWAITING_CONFIRM';
        await botReply(msg, formatSummaryMessage(profile, session.pendingData));
        console.log(`[Session] ${senderId} → AWAITING_CONFIRM`);
        return;
    }

    // ---------------------------------------------------------
    // YES / CANCEL / LOGIN — sirf AWAITING_CONFIRM state mein matter karte hain
    // (state se bahar ho to silently ignore — koi nagging reply nahi)
    // ---------------------------------------------------------
    if (session.state !== 'AWAITING_CONFIRM') {
        // Command recognize ki par session sahi state mein nahi — chhupa do
        return;
    }

    if (isCancel) {
        session.state = 'IDLE';
        session.pendingData = null;
        await botReply(msg, '❌ Cancelled. Send a new *WORK: ...* to try again.');
        return;
    }

    if (loginMatch) {
        const timePart = loginMatch[1];
        session.pendingData.loginTime = timePart;
        await botReply(msg, `✅ Login time updated to *${timePart}*. Send *YES* to confirm or *CANCEL* to discard.`);
        return;
    }

    if (isYes) {
        const fullUrl = buildPrefilledUrl(
            profile,
            session.pendingData.natureOfWork,
            session.pendingData.loginTime,
            session.pendingData.logoutTime
        );

        // Short link banao — full Google Forms URL ki jagah chhota apna domain link.
        // Agar cloud mode mein nahi (local dev), fallback to full URL.
        let displayUrl = fullUrl;
        try {
            const shortId = await db.saveShortLink(fullUrl, profile.internship_id);
            if (shortId) displayUrl = `${BOT_CONFIG.SHORT_BASE}/r/${shortId}`;
        } catch (e) {
            console.error('[ShortLink] save fail:', e.message);
        }

        // Aaj ka counter badhao (status mein dikhane ke liye)
        let stats = { todayCount: 1 };
        try {
            stats = await db.recordLinkGenerated(profile.internship_id);
        } catch (e) {
            console.error('[Stats] record fail:', e.message);
        }

        const loginDisp  = to12Hour(session.pendingData.loginTime);
        const logoutDisp = to12Hour(session.pendingData.logoutTime);
        const countLine = stats.todayCount > 1
            ? `\n_(Link #${stats.todayCount} for today)_`
            : '';

        await botReply(msg,
            `✅ *Your pre-filled form link is ready!*${countLine}\n\n` +
            `👉 ${displayUrl}\n\n` +
            `📌 *Before submitting, check the TIME fields:*\n` +
            `🕐 Login: *${session.pendingData.loginTime}* (${loginDisp})\n` +
            `🕕 Logout: *${session.pendingData.logoutTime}* (${logoutDisp})\n` +
            `_(Google Forms doesn't auto-fill time fields — if empty, just type these values manually.)_\n\n` +
            `⚠️ Don't forget to tap *Submit* — that's what marks your attendance!`
        );

        // Mark by internship_id (stable across @c.us and @lid identities)
        markSubmittedToday(profile.internship_id);
        session.state = 'IDLE';
        session.pendingData = null;
        return;
    }
}

// Register the handler for BOTH events.
// 'message'        → someone else messages you
// 'message_create' → you message yourself (Saved Messages trigger)
client.on('message', handleMessage);
client.on('message_create', handleMessage);

// --- START THE BOT -----------------------------------------------------------
console.log('🤖 Starting NPTEL Attendance Bot...');
console.log('📁 Users directory:', BOT_CONFIG.USERS_DIR);
console.log('🐍 Form filler script:', BOT_CONFIG.FORM_FILLER_SCRIPT);
console.log('');

// WHAT: client.initialize() starts the Puppeteer browser that runs WhatsApp Web.
// WHAT HAPPENS: Either shows QR code (first run) or loads saved session and connects.
client.initialize();
