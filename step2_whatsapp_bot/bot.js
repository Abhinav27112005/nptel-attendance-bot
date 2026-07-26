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
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');

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

// WHAT: Express + qr-image — tiny HTTP server jo cloud hosts (Render etc.) ko
//   "service alive hai" prove karne ke liye port bind karta hai.
// WHY:
//   - Render Web Service ko PORT bind karna ZAROORI hai warna deploy fail
//   - /health endpoint UptimeRobot use karta hai (every 5 min ping → no sleep)
//   - /qr endpoint cloud ke khoofnaak headless terminal ka solution hai —
//     browser mein QR image dikhega aur tum phone se scan kar loge
const express = require('express');
const qrImage = require('qr-image');

// WhatsApp client ki connection states track karo — /qr UI yeh use karta hai
// 4 distinct states banti hain user perspective se:
//   1. INITIALIZING  → bot boot ho raha, QR abhi generate nahi hua
//   2. WAITING_SCAN  → QR ready, user ko scan karna hai
//   3. AUTHENTICATING→ User ne scan kar liya, session setup chal raha (~5-15 sec)
//   4. READY         → Fully connected, messages handle ho rahe
let currentQR = null;
let clientReady = false;
let clientAuthenticated = false;  // scan ho gaya, ready hone ka wait
let remindersStarted = false;     // 'ready' reconnect pe cron dobara na banaye

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

// =============================================================================
// AUTH STRATEGY SELECTION — MongoDB-backed (RemoteAuth) vs Filesystem (LocalAuth)
// =============================================================================
//   Render free tier mein filesystem EPHEMERAL hai — har deploy/restart pe
//   .wwebjs_auth/ folder UDD jata hai. Iska matlab har baar fresh QR scan.
//
//   RemoteAuth WhatsApp session ko MongoDB Atlas mein store karta hai (encrypted
//   blob ki tarah). Restart pe DB se load → bot turant connect, no QR.
//
//   Decision logic:
//     - MONGODB_URI set hai (production / cloud) → RemoteAuth + MongoStore
//     - Nahi set (local dev) → LocalAuth (filesystem persistence enough)
//
//   Yeh decision build karne ke liye ek async function chahiye (mongoose
//   connect karna padta hai pehle). startBot() niche define hai.
// =============================================================================

function buildLocalAuthStrategy() {
    return new LocalAuth({
        dataPath: path.join(__dirname, '.wwebjs_auth')
    });
}

async function buildMongoAuthStrategy() {
    const { MongoStore } = require('wwebjs-mongo');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(process.env.MONGODB_URI, {
            // Reasonable timeouts for cloud DB
            serverSelectionTimeoutMS: 10000,
        });
    }
    const store = new MongoStore({ mongoose });
    return new RemoteAuth({
        store,
        clientId: 'nptel-bot',                  // multi-bot isolation
        // 60 sec — jaldi backup taaki agar Render OOM se pehle kill ho jaye, tab
        // bhi session Mongo pe save ho chuki ho. 5 min gap tha, us mein bot
        // 30-60 sec mein crash ho jata tha to session kabhi persist nahi hoti thi.
        backupSyncIntervalMs: 60 * 1000,
        dataPath: path.join(__dirname, '.wwebjs_auth')  // local cache (synced with cloud)
    });
}

async function getAuthStrategy() {
    // FORCE_LOCAL_AUTH=true → filesystem session, chahe MONGODB_URI set ho.
    // Termux/phone/VPS jaisi jagah jahan disk PERMANENT hai, LocalAuth reliable
    // hai — RemoteAuth ka Mongo-zip backup (jo kabhi-kabhi ENOENT deta) nahi chahiye.
    // Render jaisi ephemeral jagah pe yeh mat set karna (wahan RemoteAuth zaroori).
    if (process.env.FORCE_LOCAL_AUTH === 'true') {
        console.log('[Auth] Mode: LocalAuth (FORCED) — session phone/VPS disk pe persist hogi');
        return buildLocalAuthStrategy();
    }

    const uri = (process.env.MONGODB_URI || '').trim();
    const useMongo = uri && !uri.includes('PASTE_YOUR');
    if (!useMongo) {
        console.log('[Auth] Mode: LocalAuth (filesystem) — session NOT preserved across cloud deploys');
        return buildLocalAuthStrategy();
    }
    try {
        const strategy = await buildMongoAuthStrategy();
        console.log('[Auth] Mode: RemoteAuth (MongoDB) — session persists across deploys ✓');
        return strategy;
    } catch (err) {
        console.error('[Auth] MongoDB auth failed, falling back to LocalAuth:', err.message);
        return buildLocalAuthStrategy();
    }
}

// Client placeholder — actual construction happens inside startBot() because
// auth strategy resolution is async. All event handlers and HTTP server
// registration still happen at module load (they reference `client` lazily
// once it's assigned).
let client = null;

function createClient(authStrategy) {
    return new Client({
    authStrategy,
    // protocolTimeout: Chromium ke saath baat karne ka max wait. Default 180 sec.
    // Weak phone pe Chromium slow ho jata hai (message bhejte waqt), 180s mein
    // jawab na aaye to "Runtime.callFunctionOn timed out" crash. 5 min de dete hain
    // taaki slow-but-working operations crash na hon.
    puppeteer: {
        protocolTimeout: 300000,   // 5 minutes
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        // AGGRESSIVE MEMORY-OPTIMIZATION FLAGS — Render free tier (512MB) ke liye zaroori.
        // Har flag Chromium ke ek feature ko disable karta hai jo hume nahi chahiye
        // (WhatsApp Web ke liye). Combined saving: ~100-200 MB.
        //
        // NOTE: Ye sab safe hain WhatsApp Web ke liye. Sirf `--single-process`
        // NAHI use kar rahe kyunki wo instability laata hai (crashes kill everything).
        args: [
            // Base sandboxing / IPC (Linux root user + cloud shared memory fixes)
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',

            // GPU acceleration disable — headless mein waise bhi useless, saves RAM
            '--disable-gpu',
            '--disable-accelerated-2d-canvas',
            '--disable-software-rasterizer',

            // Background process kill — WhatsApp Web idle nahi hota, isliye
            // background rendering aur timer throttling ki zaroorat nahi
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',

            // Chrome ke saare "extras" nahi chahiye
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--metrics-recording-only',
            '--mute-audio',
            '--hide-scrollbars',
            '--no-first-run',
            '--no-zygote',              // one less process
            '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
        ]
    }
    });
}

// --- BOT EVENTS --------------------------------------------------------------
// LEARNING CONCEPT: Event Listeners
//   `client.on('event', cb)` registers callback for WhatsApp events.
//   Pehle yeh module-load pe register hote the. Ab `client` async banta hai
//   (RemoteAuth ke wajah se), to handlers ko ek function mein wrap karke
//   startBot() se call karte hain.

function registerClientEvents(client) {

// EVENT: qr
// WHEN: Client needs authentication (first run, or session expired)
// WHAT: New QR generated (har 20 sec rotate hota hai jab tak scan na ho)
client.on('qr', (qr) => {
    // Agar already authenticated hai (scan ho gaya), to baad mein aane wale
    // QR ko ignore karo — UI mein freshness chhupayega.
    if (clientAuthenticated) return;
    currentQR = qr;
    clientReady = false;
    console.log('\n📱 QR ready. Browser pe scan karo: <render-url>/qr\n');
    qrcode.generate(qr, { small: true });
});

// EVENT: authenticated
// WHEN: User scanned the QR successfully. Session establish ho rahi, ready abhi nahi.
// WHAT: QR ko turant freeze karo. UI "Connecting..." pe switch ho jayega.
client.on('authenticated', () => {
    clientAuthenticated = true;
    currentQR = null;        // turant QR clear karo
    console.log('✓ Scan detected — establishing session...');
});

// EVENT: ready
// WHEN: Client is fully connected and ready to receive messages
client.on('ready', async () => {
    currentQR = null;
    clientReady = true;
    clientAuthenticated = true;

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

    // Reminder scheduler — IDEMPOTENT: 'ready' event reconnect ke baad dobara fire
    // ho sakti hai (WhatsApp session refresh). Har baar startReminders call karne
    // se ek naya cron register hota hai → duplicate reminders. Flag se roko.
    //
    // getTargets ab SIRF linked users ko target karta hai — jo LINK command
    // bhej chuke hain aur whatsapp_id DB mein save hai. Unlinked users ko
    // mobile@c.us pe reminder bhejna WhatsApp se fail hota hai ("No LID for user").
    if (!remindersStarted) {
        startReminders(client, async () => {
            const users = await db.getAllUsers();
            return users
                .filter(p => p && p.internship_id && p.whatsapp_id)  // MUST be linked
                .map(p => ({
                    id: p.whatsapp_id,
                    name: p.name || p.internship_id,
                    internshipId: p.internship_id,
                    endDate: p.end_date   // internship complete check ke liye
                }));
        });
        remindersStarted = true;
    }
});

// EVENT: auth_failure
// WHEN: Authentication fails (QR scan failed or session corrupted)
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    console.log('Delete the .wwebjs_auth folder and restart to re-scan QR');
});

// EVENT: disconnected
// WHEN: WhatsApp disconnects (phone offline, manual logout, session expired)
//
// HANDLING:
//   - LOGOUT  → session DEAD. Stored session bhi delete karo. Process exit
//               karo — Render restart karega aur fresh QR ke liye prompt.
//   - Other   → transient (network blip) — wait 5 sec aur reconnect.
client.on('disconnected', async (reason) => {
    clientReady = false;
    clientAuthenticated = false;
    currentQR = null;
    console.log('⚠️ WhatsApp disconnected:', reason);

    if (reason === 'LOGOUT' || reason === 'CONFLICT') {
        // Session purani / phone se manually unlinked. Stored session ko
        // saaf karo aur fresh start ke liye exit. Render apne aap restart karega.
        console.log('🚫 Session dead — clearing storage and exiting for fresh QR');
        try {
            // RemoteAuth ke saath client.logout() store mein delete karta hai
            await Promise.race([
                client.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('logout timeout')), 8000))
            ]);
        } catch (e) {
            console.log('  (logout cleanup failed, non-fatal):', e.message);
        }
        process.exit(1);  // Render auto-restart → fresh QR on next boot
    }

    console.log('🔄 Transient disconnect — reconnecting in 5 seconds...');
    setTimeout(() => {
        try { client.initialize(); }
        catch (e) { console.error('Reconnect failed:', e.message); }
    }, 5000);
});

// =============================================================================
// HEALTH / QR / STATUS HTTP SERVER
//
// WHY:
//   - Render Web Service ko PORT pe bind hona ZAROORI hai. Bina yeh service
//     deploy fail ho jata hai ("Port scan timeout").
//   - /health endpoint UptimeRobot (free monitoring) ping karta hai har 5 min
//     → service kabhi 15-min-idle sleep mein nahi jati.
//   - /qr endpoint: cloud pe terminal QR scan possible nahi. Yeh QR ko PNG
//     image ke roop mein serve karta hai — phone se direct browser open
//     karke scan kar sakte ho.
// =============================================================================

const healthApp = express();
const PORT = process.env.PORT || 3000;

healthApp.get('/', (_req, res) => {
    res.send(`
        <html><head><title>NPTEL Bot</title></head>
        <body style="font-family:system-ui;text-align:center;padding:40px;background:#0a0e1a;color:#f1f5f9;">
            <h1 style="color:#3b82f6;">NPTEL Attendance Bot</h1>
            <p>Status: <b style="color:${clientReady ? '#10b981' : '#f59e0b'}">${clientReady ? '✓ Ready' : '⏳ Initializing'}</b></p>
            <p>Uptime: ${Math.floor(process.uptime() / 60)} minutes</p>
            ${!clientReady ? '<p><a style="color:#3b82f6" href="/qr">📱 Scan QR Code</a></p>' : ''}
            <p style="opacity:.5;font-size:12px;margin-top:30px;">Health endpoint: <code>/health</code></p>
        </body></html>
    `);
});

healthApp.get('/health', (_req, res) => {
    // Compute 4-state machine for client UI
    let state;
    if (clientReady) state = 'ready';
    else if (clientAuthenticated) state = 'connecting';   // scan ho gaya, ready ka wait
    else if (currentQR) state = 'qr';                     // QR ready, scan ka wait
    else state = 'initializing';                          // bot boot ho raha

    res.json({
        status: state,
        whatsapp_ready: clientReady,
        whatsapp_authenticated: clientAuthenticated,
        qr_pending: currentQR !== null,
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

// /qr — Full HTML page with 4-state machine + live polling.
// States: initializing → qr → connecting (scan detected) → ready
// QR is FROZEN immediately on scan (real WhatsApp Web jaisa behaviour).
healthApp.get('/qr', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NPTEL Bot — Link WhatsApp</title>
<style>
  :root { --bg:#0a0e1a; --card:#161c2e; --text:#f1f5f9; --dim:#94a3b8;
          --accent:#3b82f6; --ok:#10b981; --warn:#f59e0b; --border:rgba(148,163,184,.12); }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
    background:var(--bg);color:var(--text);min-height:100vh;font-size:15px;line-height:1.5;
    background-image:radial-gradient(900px circle at 20% -10%,rgba(59,130,246,.10),transparent 50%),
                     radial-gradient(700px circle at 95% 110%,rgba(59,130,246,.06),transparent 50%);
    background-attachment:fixed;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;
    padding:32px 28px;max-width:440px;width:100%;text-align:center;
    box-shadow:0 12px 40px rgba(0,0,0,.25);}
  h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}
  .sub{color:var(--dim);font-size:13px;margin:0 0 22px}

  /* QR display, with overlay support */
  .qr-wrap{background:#fff;border-radius:12px;padding:18px;display:inline-block;line-height:0;
    position:relative;transition:filter .35s, opacity .35s;}
  .qr-wrap img{display:block;width:240px;height:240px}
  .qr-wrap.frozen{filter:blur(8px) brightness(.7);opacity:.5;pointer-events:none}
  .qr-overlay{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
    background:rgba(16,185,129,.95);color:#fff;width:80px;height:80px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;font-size:42px;
    opacity:0;transition:opacity .35s, transform .35s;pointer-events:none;}
  .qr-wrap.frozen .qr-overlay{opacity:1;transform:translate(-50%,-50%) scale(1.1)}

  /* status badges */
  .badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;
    padding:6px 14px;border-radius:99px;margin:18px 0 12px;}
  .badge::before{content:'';width:8px;height:8px;border-radius:50%;animation:pulse 1.5s infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .badge.qr {background:rgba(59,130,246,.12);color:var(--accent);}
  .badge.qr::before {background:var(--accent);}
  .badge.connecting {background:rgba(245,158,11,.12);color:var(--warn);}
  .badge.connecting::before {background:var(--warn);}
  .badge.ready {background:rgba(16,185,129,.12);color:var(--ok);}
  .badge.ready::before {background:var(--ok);animation:none}

  /* Spinner for connecting state */
  .spinner{width:48px;height:48px;border:4px solid rgba(245,158,11,.2);
    border-top-color:var(--warn);border-radius:50%;animation:spin 0.8s linear infinite;
    margin:8px auto 16px;}
  @keyframes spin{to{transform:rotate(360deg)}}

  .steps{text-align:left;font-size:13px;color:var(--dim);margin:14px 0 0;padding:14px 16px;
    background:rgba(0,0,0,.2);border-radius:10px;border:1px solid var(--border);}
  .steps b{color:var(--text)}
  .steps ol{margin:0;padding-left:18px}
  .success-icon{font-size:56px;margin-bottom:8px;animation:pop .4s ease}
  @keyframes pop{from{transform:scale(.5);opacity:0}to{transform:scale(1);opacity:1}}
  .ok h1{color:var(--ok)}
  .pending h1{color:var(--warn)}
  .footer{margin-top:18px;font-size:11px;color:var(--dim);opacity:.6}
</style>
</head><body>
<div id="root" class="card">
  <div class="badge qr">Loading…</div>
</div>
<script>
  const root = document.getElementById('root');

  function renderInit() {
    root.innerHTML = \`
      <div class="pending">
        <h1>⏳ Bot starting…</h1>
        <p class="sub">Puppeteer Chrome boot ho raha. QR ~10 sec mein dikhega.</p>
        <div class="spinner"></div>
      </div>\`;
  }

  function renderQR() {
    // cache-bust ke saath fresh QR image lo
    const ts = Date.now();
    root.innerHTML = \`
      <h1>📱 Scan to Link WhatsApp</h1>
      <p class="sub">Open WhatsApp → <b>Settings</b> → <b>Linked Devices</b> → <b>Link a Device</b></p>
      <div id="qrWrap" class="qr-wrap">
        <img src="/qr.png?t=\${ts}" alt="QR code" />
        <div class="qr-overlay">✓</div>
      </div>
      <div class="badge qr">Waiting for scan…</div>
      <div class="steps">
        <ol>
          <li>Phone se camera QR pe focus karo</li>
          <li>Scan hote hi QR <b>freeze ho jayega</b> aur status update milega</li>
          <li>~10 sec session connect mein lagte hain — page band mat karo</li>
        </ol>
      </div>\`;
  }

  function renderConnecting() {
    // Freeze the QR image instead of removing it — UX hint that scan was detected
    const wrap = document.getElementById('qrWrap');
    if (wrap) {
      wrap.classList.add('frozen');
      // Update badge + steps section in place
      const badge = root.querySelector('.badge');
      if (badge) {
        badge.className = 'badge connecting';
        badge.textContent = 'Scan detected — connecting…';
      }
      const steps = root.querySelector('.steps');
      if (steps) {
        steps.innerHTML = '<b>✓ Scan successful!</b><br>Session establish ho rahi, ~5-15 sec lagega…';
      }
      return;
    }
    // Agar QR page render hi nahi tha (deep link directly to /qr after restart), fallback
    root.innerHTML = \`
      <div class="pending">
        <h1>⏳ Connecting…</h1>
        <p class="sub">Scan detected, WhatsApp session establish ho rahi…</p>
        <div class="spinner"></div>
        <div class="badge connecting">Authenticating</div>
      </div>\`;
  }

  function renderReady() {
    root.innerHTML = \`
      <div class="ok">
        <div class="success-icon">✅</div>
        <h1>Connected!</h1>
        <p class="sub">WhatsApp session active. Bot attendance commands ke liye ready hai.</p>
        <div class="badge ready">Online</div>
        <div class="steps" style="text-align:center">
          Ab WhatsApp pe bhejо: <b>!status</b> ya <b>WORK: aaj jo kaam kiya</b>
        </div>
      </div>\`;
  }

  let lastState = null;
  let lastQRTs = 0;

  async function poll() {
    try {
      const r = await fetch('/health', { cache: 'no-store' });
      const d = await r.json();
      const state = d.status;  // initializing | qr | connecting | ready

      // State transitions: re-render only on change
      if (state !== lastState) {
        if (state === 'initializing') renderInit();
        else if (state === 'qr') { renderQR(); lastQRTs = Date.now(); }
        else if (state === 'connecting') renderConnecting();
        else if (state === 'ready') renderReady();
        lastState = state;
        return;
      }
      // Same state — only refresh QR image every 15s while in 'qr' state
      if (state === 'qr' && (Date.now() - lastQRTs) > 15000) {
        const img = root.querySelector('.qr-wrap img');
        if (img) img.src = '/qr.png?t=' + Date.now();
        lastQRTs = Date.now();
      }
    } catch (e) { /* ignore transient network errors */ }
  }
  poll();
  setInterval(poll, 1500);
</script>
</body></html>`);
});

// /qr.png — raw PNG image, no HTML. <img src="/qr.png"> use karta hai.
healthApp.get('/qr.png', (_req, res) => {
    if (!currentQR || clientReady) {
        // 1x1 transparent PNG (no QR available)
        const blank = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64');
        res.type('png').send(blank);
        return;
    }
    res.type('png');
    res.set('Cache-Control', 'no-store');
    qrImage.image(currentQR, { type: 'png', size: 10 }).pipe(res);
});

healthApp.listen(PORT, '0.0.0.0', () => {
    console.log(`[Health] HTTP server listening on port ${PORT}`);
    console.log(`[Health] /qr endpoint ready for QR scanning`);
});

// =============================================================================
// HEARTBEAT — "Bot down" alert via healthchecks.io
//
// WHY: Bot phone/Termux pe chalta hai — battery, network ya crash se chup-chaap
//   band ho sakta hai aur pata nahi chalta. Yeh har 5 min healthchecks.io ko
//   ek ping bhejta hai (SIRF jab WhatsApp connected ho). Ping ruk gaya to
//   healthchecks.io tumhe email/telegram alert bhejta hai.
//
// SETUP: .env mein HEALTHCHECK_URL=https://hc-ping.com/<your-uuid> daalo.
//   Na set ho to yeh chup-chaap skip ho jata hai (koi error nahi).
// =============================================================================
function startHeartbeat() {
    const url = (process.env.HEALTHCHECK_URL || '').trim();
    if (!url || !url.startsWith('http')) {
        console.log('[Heartbeat] HEALTHCHECK_URL set nahi — down-alerts OFF');
        return;
    }
    const ping = async () => {
        // Sirf tab ping karo jab WhatsApp sach mein connected ho.
        // Isse process-death AUR WhatsApp-disconnect dono catch hote hain.
        if (!clientReady) return;
        try {
            await fetch(url, { method: 'GET' });
        } catch (e) {
            console.log('[Heartbeat] ping fail (network?):', e.message);
        }
    };
    setInterval(ping, 5 * 60 * 1000);  // har 5 min
    console.log('[Heartbeat] ON — healthchecks.io ko har 5 min ping (jab connected)');
}
startHeartbeat();

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

/**
 * Promise ko ek max time deta hai. Us time mein complete na ho to reject.
 * Weak phone pe slow DB/network ki wajah se bot ko "processing" pe atakne se bachata hai.
 */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms))
    ]);
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

// Outer wrapper — async functions ke errors WhatsApp event emitter ke saath
// silently swallowed ho jate hain (unhandled rejection). Yeh wrapper unko
// catch karke log karta hai taaki bot chup-chap fail nahi ho.
async function handleMessage(msg) {
    try {
        await _handleMessageInner(msg);
    } catch (err) {
        console.error('[handleMessage CRASH]', err.message || err);
        // ProtocolError/timeout = Chromium slow tha (phone weak). Us waqt aur ek
        // reply bhejna page pe aur bojh daalta hai → skip. Sirf log karo.
        const isTimeout = /ProtocolError|timed out|Target closed|Session closed/i.test(String(err?.message || err));
        if (isTimeout) return;
        // Baaki genuine errors pe hi user ko batao
        try {
            await msg.reply('⚠️ Kuch gadbad hui, dobara try karo.');
        } catch { /* ignore reply failure */ }
    }
}

async function _handleMessageInner(msg) {
    // GROUP MESSAGES IGNORE — bot sirf 1-on-1 attendance ke liye hai. Group
    // spam (jaise "Ab roz hogi baarish") har message pe DB lookup + processing
    // karke phone pe bekar bojh daalta tha. Turant nikal jao.
    if (msg.from?.endsWith('@g.us')) return;

    // Pehla check: yeh message pehle process ho chuka? (dual-event dedup)
    if (alreadyProcessed(msg)) return;

    // Capture our own @lid from a self-message (jab tum khud ko message bhejte ho).
    // STRICTER CONDITIONS taaki galat @lid na pakde:
    //   1. msg.fromMe === true (definitely sent by our account)
    //   2. msg.from === msg.to (self-message — tumhi ne tumhi ko bheja)
    //   3. Extension @lid hai (@c.us user ka nahi)
    //   4. MY_LID abhi tak set nahi (idempotent — dobara overwrite nahi)
    //
    // Purana bug: sirf msg.to.endsWith('@lid') check hota tha. Fir agar bot ne
    // apni reply kisi @lid user ko bheji, wo user ka LID capture ho jata tha,
    // aur us user ke aage ke messages "bot's own reply" samajh ke ignore hote.
    if (msg.fromMe && msg.from === msg.to && msg.to?.endsWith('@lid') && !MY_LID) {
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
        console.log(`[LINK] Request from ${senderId} for ID=${internshipId}`);

        // Already linked? (lookup by whatsapp_id OR mobile)
        console.log('[LINK] Step 1: checking if already linked...');
        const { profile: existing } = await findUserByMessage(msg);
        if (existing) {
            console.log(`[LINK] Already linked to ${existing.internship_id}`);
            await botReply(msg,
                `✅ Already linked!\n👤 ${existing.name} (${existing.internship_id})`
            );
            return;
        }

        // Find profile by ID, then save this WhatsApp ID into it.
        console.log(`[LINK] Step 2: linking ${msg.from} → ${internshipId}`);
        const linked = await db.linkWhatsappId(internshipId, msg.from);
        console.log(`[LINK] Step 3: db.linkWhatsappId returned ${linked}`);

        if (!linked) {
            console.log(`[LINK] ID ${internshipId} NOT FOUND in DB`);
            await botReply(msg,
                `❌ Internship ID *${internshipId}* not found.\n\n` +
                `Please register first: ${BOT_CONFIG.REGISTER_URL}\n` +
                `Then come back and send *LINK ${internshipId}* again.`
            );
            return;
        }

        console.log(`[LINK] Step 4: verifying save by re-fetching profile`);
        const { profile: verifyProfile } = await findUserByMessage(msg);
        console.log(`[LINK] Step 5: verified — whatsapp_id=${verifyProfile?.whatsapp_id || 'MISSING!'}`);

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

    // GUARD: state AWAITING_CONFIRM hai par pendingData khaali? (inconsistent state,
    // ya YES do baar aa gaya). Crash se bachne ke liye reset karke dobara maango.
    if (!session.pendingData) {
        session.state = 'IDLE';
        await botReply(msg, '⚠️ Session reset ho gaya. Naya *WORK: ...* bhejo.');
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
        // pendingData local mein copy (double-YES/reconnect se safe)
        const pd = { ...session.pendingData };
        session.state = 'IDLE';
        session.pendingData = null;

        const loginDisp  = to12Hour(pd.loginTime);
        const logoutDisp = to12Hour(pd.logoutTime);

        // Pre-filled link banao. Bot form KHUD submit NAHI karta — user apne
        // Chrome se (registered Gmail se) khud submit karta hai, tabhi attendance
        // NPTEL ke records mein count hoti hai. Ye jaan-bujhke manual rakha hai.
        const fullUrl = buildPrefilledUrl(profile, pd.natureOfWork, pd.loginTime, pd.logoutTime);

        // Short link — 6 sec se zyada MongoDB pe atke to full URL bhej do.
        let displayUrl = fullUrl;
        let expiresAt = null;
        try {
            const r = await withTimeout(db.saveShortLink(fullUrl, profile.internship_id), 6000);
            if (r?.shortId) { displayUrl = `${BOT_CONFIG.SHORT_BASE}/r/${r.shortId}`; expiresAt = r.expiresAt; }
        } catch (e) { console.error('[ShortLink] skip:', e.message); }

        let stats = { todayCount: 1 };
        try { stats = await withTimeout(db.recordLinkGenerated(profile.internship_id), 4000); }
        catch (e) { console.error('[Stats] skip:', e.message); }

        const countLine = stats.todayCount > 1 ? `\n_(Link #${stats.todayCount} for today)_` : '';

        let expiryLine = '';
        if (expiresAt) {
            const e = new Date(expiresAt);
            expiryLine = `⏳ *Link expires at ${String(e.getHours()).padStart(2,'0')}:${String(e.getMinutes()).padStart(2,'0')}* (30 min).\n\n`;
        }

        await botReply(msg,
            `✅ *Your pre-filled form link is ready!*${countLine}\n\n` +
            `👉 ${displayUrl}\n\n` +
            expiryLine +
            `📌 *Ise apne CHROME mein kholo* (jisme tumhara NPTEL-registered Gmail logged-in ho) — ` +
            `tabhi attendance count hoti hai.\n\n` +
            `🔎 *Submit se pehle verify karo:*\n` +
            `🕐 Login: *${pd.loginTime}* (${loginDisp})\n` +
            `🕕 Logout: *${pd.logoutTime}* (${logoutDisp})\n` +
            `📝 Work: ${pd.natureOfWork}\n` +
            `_(Time fields khaali hon to khud bhar lena.)_\n\n` +
            `⚠️ *Submit tum khud dabao* — bot submit nahi karta.`
        );

        try { markSubmittedToday(profile.internship_id); } catch (e) { console.error('[Reminder] mark fail:', e.message); }
        return;
    }
}

// Register the handler for BOTH events.
// 'message'        → someone else messages you
// 'message_create' → you message yourself (Saved Messages trigger)
client.on('message', handleMessage);
client.on('message_create', handleMessage);

// EVENT: remote_session_saved (RemoteAuth only)
// WHEN: backupSyncIntervalMs fires aur session DB pe sync hoti hai
client.on('remote_session_saved', () => {
    console.log('[Auth] Session backed up to MongoDB ✓');
});

}  // end registerClientEvents

// --- START THE BOT -----------------------------------------------------------
console.log('🤖 Starting NPTEL Attendance Bot...');
console.log('📁 Users directory:', BOT_CONFIG.USERS_DIR);
console.log('🐍 Form filler script:', BOT_CONFIG.FORM_FILLER_SCRIPT);
console.log('');

async function startBot() {
    const authStrategy = await getAuthStrategy();
    client = createClient(authStrategy);
    registerClientEvents(client);
    // client.initialize() starts the Puppeteer browser that runs WhatsApp Web.
    // Either shows QR code (first run) or loads saved session and connects.
    client.initialize();
}

startBot().catch(err => {
    console.error('[FATAL] startBot crashed:', err);
    process.exit(1);
});

// =============================================================================
// GRACEFUL SHUTDOWN — Ctrl+C aur cloud-host SIGTERM ko properly handle karo
//
// WHY THIS MATTERS:
//   Abrupt kill (Ctrl+C without cleanup) se WhatsApp session disk pe
//   poori tarah save nahi hoti. Result: next startup pe corrupted session
//   → QR loop. Yeh handler client ko gracefully destroy karta hai pehle
//   exit karne se → session safely flush hoti hai.
//
//   Render aur cloud hosts SIGTERM bhejte hain (jab tak 10 sec mein
//   process exit nahi hota, force kill SIGKILL). Yeh handler 10 sec
//   ke andar clean shutdown ensure karta hai.
// =============================================================================
let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;       // double-Ctrl+C → force exit
    shuttingDown = true;
    console.log(`\n👋 ${signal} received — closing WhatsApp client cleanly...`);
    try {
        // 8-second budget for client.destroy(); warna force exit
        // client null ho sakta hai agar startBot() puri tarah complete nahi hua
        if (client && typeof client.destroy === 'function') {
            await Promise.race([
                client.destroy(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
            ]);
        }
        console.log('✅ Session saved. Bye.');
    } catch (e) {
        console.log('⚠️ Clean shutdown failed:', e.message);
    }
    process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));  // cloud host stop

// Unhandled promise rejections (jaise prefill DB call jo error throw kare)
// bot ko crash kar dete the silently. Yahan log karte hain — bot zinda rehta hai.
process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err);
});

// Uncaught exceptions — usually EventEmitter 'error' events jo listen nahi hue.
// Node default behavior: process crash. Hum specific known-harmless errors ko
// swallow karte hain aur baaki ke liye clean exit (Render/PM2 restart karega).
process.on('uncaughtException', (err) => {
    // wwebjs-mongo ka periodic backup task kabhi-kabhi zip creation ke bich
    // race condition mein fail hota hai. Non-fatal — bot chal raha hai, sirf
    // is cycle ka MongoDB backup skip ho jata hai. Agla cycle 60 sec baad
    // dobara try karega.
    if (err?.code === 'ENOENT' && String(err?.path || '').includes('RemoteAuth-')) {
        console.log('[Auth] Session backup skipped (transient):', err.message);
        return;
    }
    // Real uncaught exception — log + exit for restart
    console.error('[UNCAUGHT EXCEPTION]', err);
    process.exit(1);
});
