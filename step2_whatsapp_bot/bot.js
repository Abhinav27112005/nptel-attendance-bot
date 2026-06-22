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
 * Message se user ka profile dhoondho — DB se mobile number ke base par.
 *
 * IMPORTANT: msg.from kabhi @c.us hota hai (asli phone number) aur kabhi @lid
 *   (WhatsApp ki internal device ID — yeh asli number NAHI hai).
 *   Doosre logon ke messages aksar @lid mein aate hain.
 *   Asli mobile number nikalne ke liye msg.getContact() use karte hain —
 *   yeh WhatsApp Web se contact ki info laata hai, jisme .number = asli phone.
 *
 * @param {object} msg - whatsapp-web.js ka message object
 * @returns {Promise<{profile: object|null, mobile: string|null}>}
 */
async function findUserByMessage(msg) {
    let mobile = null;

    // Pehle koshish karo @c.us se (sidha number)
    if (msg.from.endsWith('@c.us')) {
        mobile = msg.from.replace('@c.us', '');
    } else {
        // @lid hai — WhatsApp se contact info maango, .number = asli mobile
        try {
            const contact = await msg.getContact();
            mobile = contact?.number || null;
        } catch (e) {
            console.error('[Auth] getContact fail:', e.message);
        }
    }

    if (!mobile) return { profile: null, mobile: null };

    const profile = await db.getUserByMobile(mobile);
    return { profile, mobile };
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
 * Formats a summary message showing what will be submitted.
 * Shown to user before they confirm.
 *
 * @param {object} profile - user profile
 * @param {object} pendingData - the data to be submitted
 * @returns {string} formatted WhatsApp message
 */
function formatSummaryMessage(profile, pendingData) {
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
🕐 Login Time: ${pendingData.loginTime}
🕕 Logout Time: ${pendingData.logoutTime}
📝 Work Done: ${pendingData.natureOfWork}
─────────────────────
✅ *YES* bhejo → bhara-bharaya form link milega
🕐 *LOGIN HH:MM* → login time badlo (jaise LOGIN 10:30)
❌ *CANCEL* → radd karo`;
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

    // Reminder scheduler shuru karo.
    // getTargets() saare registered users ki list deta hai (MULTI-USER).
    // Ab ASYNC hai — db se users aate hain.
    startReminders(client, async () => {
        const users = await db.getAllUsers();
        return users.map(p => ({
            id: `${p.mobile.replace(/[+\s]/g, '')}@c.us`,  // "919835262809@c.us"
            name: p.name
        }));
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

async function handleMessage(msg) {
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
    //   Ye registered/unregistered DONO ke liye chalta hai (naya user onboard ho sake).
    //   trim + toUpperCase taaki "register", "Register", " REGISTER " sab chale.
    // ---------------------------------------------------------
    if (messageBody.trim().toUpperCase() === 'REGISTER') {
        await botReply(msg,
            `📝 *NPTEL Attendance Bot — Registration*\n\n` +
            `Niche link kholo aur apna *offer letter PDF* upload karo — ` +
            `details apne aap nikal lenge.\n\n` +
            `👉 ${BOT_CONFIG.REGISTER_URL}\n\n` +
            `Register hone ke baad, attendance ke liye bas bhejo:\n` +
            `*WORK: aaj jo kaam kiya*`
        );
        return;
    }

    // ---------------------------------------------------------
    // GATE 2: Number registered hai? (MULTI-USER)
    //   findUserByWhatsAppId users/ folder mein dekhta hai is number ka
    //   profile hai ya nahi. Mil gaya to profile object, warna null.
    // ---------------------------------------------------------
    const { profile, mobile } = await findUserByMessage(msg);

    if (!profile) {
        // Unregistered — privacy ke liye chup raho. (REGISTER bhejne par link mil jata hai.)
        console.log(`[Auth] Unregistered mobile=${mobile || '?'} (from=${senderId}) — ignored`);
        return;
    }
    console.log(`[Auth] ${profile.name} (${mobile}) — processing`);

    console.log(`[Auth] Registered user: ${profile.name}`);

    const session = getSession(senderId);

    // ---------------------------------------------------------
    // COMMANDS (! se shuru) — sirf registered users ke liye
    // ---------------------------------------------------------
    if (messageBody.startsWith(BOT_CONFIG.COMMAND_PREFIX)) {
        const command = messageBody.slice(1).toLowerCase();

        if (command === 'help') {
            await botReply(msg,
                `*NPTEL Attendance Bot* 🤖\n\n` +
                `Attendance bharne ke liye aise likho:\n` +
                `*WORK: aaj jo kaam kiya uska ek line description*\n\n` +
                `Example:\n_WORK: Worked on data preprocessing and model training_\n\n` +
                `Phir summary aayega → *YES* bhejo → bhara-bharaya form link milega.\n\n` +
                `Commands:\n!help - ye message\n!status - bot status`
            );
            return;
        }

        if (command === 'status') {
            await botReply(msg, `Bot chal raha hai ✅\nUser: ${profile.name}\nState: ${session.state}`);
            return;
        }

        await botReply(msg,`Unknown command: ${messageBody}\nSend !help for help.`);
        return;
    }

    // ---------------------------------------------------------
    // STATE MACHINE — current state ke hisaab se message handle karo
    // (session aur profile upar already nikal liye hain)
    // ---------------------------------------------------------

    // === STATE: IDLE ===
    // Sirf "WORK: ..." format ka message hi automation trigger kare.
    // LEARNING CONCEPT: Trigger prefix + regex
    //   /^WORK:\s*(.+)/is ka matlab:
    //     ^WORK:  → message "WORK:" se shuru ho
    //     \s*     → uske baad spaces (optional)
    //     (.+)    → uske baad jo bhi (kaam ka description) — ye capture hota hai
    //     i       → case-insensitive (work:, WORK:, Work: sab chalega)
    //     s       → "." newline ko bhi match kare (multi-line description)
    if (session.state === 'IDLE') {
        const workMatch = messageBody.match(/^WORK:\s*(.+)/is);

        if (!workMatch) {
            // "WORK:" format nahi hai → normal personal message, IGNORE karo.
            // Isse bot personal baaton mein dakhal nahi deta (privacy).
            console.log(`[Session] ${profile.name}: non-WORK message ignored`);
            return;
        }

        const natureOfWork = workMatch[1].trim();  // "WORK:" ke baad ka text

        // Logout time = message bhejne ka time (kaam abhi khatam hua)
        const logoutTime = `${String(messageTime.getHours()).padStart(2, '0')}:${String(messageTime.getMinutes()).padStart(2, '0')}`;

        session.pendingData = {
            natureOfWork: natureOfWork,
            loginTime: profile.default_login_time,  // default 09:45 — LOGIN se badal sakta hai
            logoutTime: logoutTime
        };
        session.state = 'AWAITING_CONFIRM';

        await botReply(msg, formatSummaryMessage(profile, session.pendingData));
        console.log(`[Session] ${senderId} → AWAITING_CONFIRM`);
        return;
    }

    // === STATE: AWAITING_CONFIRM ===
    // YES / LOGIN HH:MM / CANCEL ka intezaar.
    if (session.state === 'AWAITING_CONFIRM') {
        const upperMsg = messageBody.toUpperCase();

        // --- Cancel ---
        if (upperMsg === 'CANCEL') {
            session.state = 'IDLE';
            session.pendingData = null;
            await botReply(msg, '❌ Cancel ho gaya. Naya kaam likho dobara try karne ke liye.');
            return;
        }

        // --- Login time badalna (optional) ---
        if (upperMsg.startsWith('LOGIN ')) {
            const timePart = messageBody.split(' ')[1];  // "10:30"
            if (!/^\d{1,2}:\d{2}$/.test(timePart)) {
                await botReply(msg, '❌ Galat format. Aise likho: LOGIN HH:MM (jaise LOGIN 10:30)');
                return;
            }
            session.pendingData.loginTime = timePart;
            await botReply(msg, `✅ Login time ab ${timePart}. *YES* bhejo confirm karne ke liye ya *CANCEL*.`);
            return;
        }

        // --- Confirm → pre-filled link bhejo ---
        if (upperMsg === 'YES') {
            // Bhara-bharaya Google Form link banao
            const url = buildPrefilledUrl(
                profile,
                session.pendingData.natureOfWork,
                session.pendingData.loginTime,
                session.pendingData.logoutTime
            );

            await botReply(msg,
                `✅ *Tumhara bhara-bharaya form link tayyar hai!*\n\n` +
                `👇 Is link ko apne phone pe tap karo. Form tumhare Chrome mein, tumhare Gmail se khulega — ` +
                `sab fields PEHLE SE bhare honge.\n\n` +
                `📌 Sirf neeche scroll karke *Submit* dabao.\n\n` +
                `${url}\n\n` +
                `⚠️ Submit dabana mat bhoolna — tabhi attendance lagegi!`
            );

            // Link bhej diya → aaj ke reminder band (maan lete hain submit kar doge)
            markSubmittedToday(senderId);

            session.state = 'IDLE';
            session.pendingData = null;
            return;
        }

        // --- Kuch aur bheja ---
        await botReply(msg,
            '⚠️ Confirmation ka intezaar hai.\n' +
            '*YES* = link bhejo | *LOGIN HH:MM* = login time badlo | *CANCEL* = radd karo'
        );
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
