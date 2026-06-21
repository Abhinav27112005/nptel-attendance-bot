// =============================================================================
// FILE: reminder.js
// PURPOSE: Shaam 5 baje ke baad har 30 minute mein user ko reminder bhejta hai
//          "Attendance bharo! Aaj kya kiya?" — JAB TAK user aaj bhar na de.
//
// LEARNING CONCEPT: Scheduler / Cron Job
//   Normal code ek baar chalta hai aur khatam.
//   Lekin reminder ko BAAR-BAAR chalna hai (har 30 min).
//   Iske liye "cron" use karte hain — ek aisa system jo decide karta hai
//   "is time pe yeh code chalao".
//
//   Example samjho: Ghar ka alarm clock.
//   Tum set karte ho "subah 7 baje bajna". Clock khud check karta rehta hai,
//   jab 7 baje hote hain — alarm bajta hai. Cron bilkul wahi hai code ke liye.
//
// CRON SYNTAX:
//   '*/30 17-23 * * *'  ka matlab:
//    │    │    │ │ │
//    │    │    │ │ └── din of week (* = koi bhi din)
//    │    │    │ └──── mahina (* = koi bhi mahina)
//    │    │    └────── tareekh (* = koi bhi tareekh)
//    │    └─────────── ghanta (17-23 = shaam 5 baje se raat 11 baje tak)
//    └──────────────── minute (*/30 = har 30 minute mein)
//
//   To pura matlab: "shaam 5 se raat 11 ke beech, har 30 minute mein chalao"
// =============================================================================

// node-cron library — yeh scheduling ka kaam karti hai.
// Install karna: npm install node-cron
const cron = require('node-cron');

// fs = file system, taaki hum tracker file padh/likh sakein.
const fs = require('fs');
const path = require('path');

// Tracker file ka path — yeh yaad rakhega kisne kab attendance bhari.
// WHY file (memory nahi)? Agar bot restart ho jaye, to memory saaf ho jaati hai.
// File disk pe rehti hai — restart ke baad bhi data bacha rehta hai.
const STATE_FILE = path.join(__dirname, '..', 'logs', 'attendance_state.json');

// -----------------------------------------------------------------------------
// HELPER 1: Aaj ki date string nikalo (YYYY-MM-DD format mein)
// -----------------------------------------------------------------------------
// WHY string? Date object compare karna mushkil hai. String "2026-06-21"
// compare karna aasaan — bas equal hai ya nahi check karo.
function getTodayString() {
    const now = new Date();
    const year = now.getFullYear();
    // getMonth() 0 se start hota hai (January = 0), isliye +1
    // padStart(2, '0') => 6 ko "06" bana deta hai (2 digit ke liye)
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;  // "2026-06-21"
}

// -----------------------------------------------------------------------------
// HELPER 2: Tracker file padho
// -----------------------------------------------------------------------------
// Returns: ek object jaise { "919835262809@c.us": "2026-06-21" }
// Matlab "is user ne 21 June ko attendance bhari thi"
function loadState() {
    try {
        // File padhne ki koshish karo
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        return JSON.parse(data);  // JSON text ko object banao
    } catch (e) {
        // Agar file exist hi nahi karti (pehli baar), to khaali object do
        return {};
    }
}

// -----------------------------------------------------------------------------
// HELPER 3: Tracker file mein likho
// -----------------------------------------------------------------------------
function saveState(state) {
    // object ko JSON text banao (null, 2 = pretty formatting ke liye)
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// -----------------------------------------------------------------------------
// PUBLIC FUNCTION 1: Mark karo ki user ne aaj attendance bhar di
// -----------------------------------------------------------------------------
// Yeh bot.js call karega jab form successfully submit ho jaye.
// Iske baad reminder band ho jayega us user ke liye (aaj ke din).
function markSubmittedToday(userId) {
    const state = loadState();
    state[userId] = getTodayString();  // "is user ne aaj bhar di"
    saveState(state);
    console.log(`[Reminder] ${userId} ne aaj attendance bhar di — reminder band.`);
}

// -----------------------------------------------------------------------------
// PUBLIC FUNCTION 2: Check karo ki user ne aaj bhari ya nahi
// -----------------------------------------------------------------------------
function hasSubmittedToday(userId) {
    const state = loadState();
    // Agar is user ki saved date == aaj ki date, to haan bhar di
    return state[userId] === getTodayString();
}

// -----------------------------------------------------------------------------
// MAIN FUNCTION: Reminder scheduler shuru karo
// -----------------------------------------------------------------------------
// Parameters:
//   client     → WhatsApp client (message bhejne ke liye)
//   getTargets → ek function jo batata hai "kis-kis ko reminder bhejna hai"
//                Phase 1 mein: sirf tum. Phase 2 mein: saare registered users.
function startReminders(client, getTargets) {
    console.log('[Reminder] Scheduler shuru — shaam 5 baje se har 30 min reminder.');

    // cron.schedule(pattern, callback)
    // Pattern: '*/30 17-23 * * *' = shaam 5 se raat 11, har 30 min
    //
    // TEST karne ke liye: '*/1 * * * *' use karo (har 1 minute) — turant dikhega.
    cron.schedule('*/30 17-23 * * *', async () => {
        console.log(`[Reminder] ${new Date().toLocaleTimeString()} — check kar raha hoon...`);

        // Kis-kis ko bhejna hai? getTargets() se list lo.
        // await — ab ye async hai (db se users aate hain).
        const targets = await getTargets();  // [{ id: "...@c.us", name: "Abhinav" }, ...]

        for (const user of targets) {
            // Agar user ne AAJ pehle hi bhar di hai — to skip karo, pareshan mat karo.
            if (hasSubmittedToday(user.id)) {
                console.log(`[Reminder] ${user.name} ne bhar di — skip.`);
                continue;  // agle user pe jao
            }

            // Warna reminder bhejo
            const reminderText =
                `⏰ *Attendance Reminder*\n\n` +
                `Hi ${user.name}! Aaj ki attendance abhi tak nahi bhari. 📝\n\n` +
                `Bas yahan likho aaj kya kaam kiya, main form bhar dunga.\n` +
                `Example: _"Aaj maine ML model train kiya"_`;

            try {
                // client.sendMessage(kisko, kya) — proactive message bhejta hai
                await client.sendMessage(user.id, reminderText);
                console.log(`[Reminder] ${user.name} ko reminder bhej diya.`);
            } catch (err) {
                console.error(`[Reminder] ${user.name} ko bhejne mein error:`, err.message);
            }
        }
    });
}

// Yeh functions baahar (bot.js) use kar sake, isliye export karte hain.
module.exports = {
    startReminders,
    markSubmittedToday,
    hasSubmittedToday
};
