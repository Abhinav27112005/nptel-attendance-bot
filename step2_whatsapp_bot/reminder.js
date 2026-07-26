// =============================================================================
// FILE: reminder.js
// PURPOSE: After 5 PM IST, every 30 minutes, ping each registered user who
//          hasn't submitted today's attendance yet.
//
// LEARNING CONCEPT: Cron scheduler
//   `cron.schedule(pattern, callback)` keeps running the callback on a schedule.
//   Pattern '*/30 17-23 * * *' means:
//     minute=*/30 (every 30 min), hour=17-23 (5 PM – 11 PM), day/month/dow=*
//
// TIMEZONE NOTE — IMPORTANT
//   cron uses the SERVER's local timezone by default.
//   If hosted on Render/etc. that's UTC → 17:00 UTC = 22:30 IST (very late!).
//   We pass timezone: 'Asia/Kolkata' so reminders fire at the right IST hour
//   no matter where the bot is hosted.
// =============================================================================

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// State file — remembers who already submitted today.
// Survives bot restart (lives on disk, not RAM).
const STATE_FILE = path.join(__dirname, '..', 'logs', 'attendance_state.json');

// Today's date as "YYYY-MM-DD" string (easy to compare).
function getTodayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return {}; }
}

function saveState(state) {
    // Ensure logs dir exists (first run on a fresh host)
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Mark a user as having submitted today.
 * KEY = internship_id (stable across @c.us and @lid — both can map to the
 * same user). Earlier we used the WhatsApp ID directly, which broke for
 * @lid users (state saved under @lid, reminder checked @c.us → no match
 * → user got spammed reminders even after submitting).
 */
function markSubmittedToday(internshipId) {
    if (!internshipId) return;
    const state = loadState();
    state[internshipId] = getTodayString();
    saveState(state);
    console.log(`[Reminder] ${internshipId} submitted today — reminders OFF.`);
}

function hasSubmittedToday(internshipId) {
    if (!internshipId) return false;
    return loadState()[internshipId] === getTodayString();
}

// -----------------------------------------------------------------------------
// INTERNSHIP COMPLETION — congrats once, phir reminders band
// -----------------------------------------------------------------------------
// Internship complete = aaj ki date user ke end_date se AAGE nikal gayi.
// Dono "YYYY-MM-DD" strings hain, isliye seedha string compare kaam karta hai
// ("2026-08-11" > "2026-08-10" → true).
function isInternshipOver(endDate) {
    if (!endDate) return false;
    return getTodayString() > endDate;
}

// Congrats sirf EK BAAR bhejna hai (warna har 30 min congrats aayega).
// State file mein ek reserved key "_congratulated" mein track karte hain.
// (Internship IDs jaise "SUM260130" hote hain, isliye "_congratulated"
//  kisi user ID se clash nahi karega.)
function wasCongratulated(internshipId) {
    const state = loadState();
    return !!(state._congratulated && state._congratulated[internshipId]);
}
function markCongratulated(internshipId) {
    const state = loadState();
    if (!state._congratulated) state._congratulated = {};
    state._congratulated[internshipId] = getTodayString();
    saveState(state);
}

/**
 * Start the reminder scheduler.
 * @param {object} client       WhatsApp client (sendMessage)
 * @param {function} getTargets async () => [{ id, name, internshipId, endDate }, ...]
 */
function startReminders(client, getTargets) {
    console.log('[Reminder] Scheduler started — pings every 30 min from 5 PM to 11 PM IST.');

    cron.schedule('*/30 17-23 * * *', async () => {
        console.log(`[Reminder] ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — checking users...`);

        const targets = await getTargets();

        for (const user of targets) {
            // 1) Internship complete? → congrats (ek baar) → koi aur reminder nahi.
            if (isInternshipOver(user.endDate)) {
                if (!wasCongratulated(user.internshipId)) {
                    const congratsText =
                        `🎉 *Congratulations, ${user.name}!* 🎓\n\n` +
                        `Aapki *NPTEL Summer Internship 2026* successfully complete ho gayi! 🙌\n\n` +
                        `Poore internship ke dauraan regularly attendance mark karne ke liye shukriya. ` +
                        `Aapki mehnat rang laayi! 💪\n\n` +
                        `_Ab se koi attendance reminder nahi aayega._\n\n` +
                        `Aage ke safar ke liye All the Best! 🚀`;
                    try {
                        await client.sendMessage(user.id, congratsText);
                        markCongratulated(user.internshipId);
                        console.log(`[Reminder] ${user.name} internship complete — congrats sent, reminders OFF.`);
                    } catch (err) {
                        console.error(`[Reminder] Congrats failed for ${user.name}:`, err.message);
                    }
                }
                continue;  // complete users ko attendance reminder nahi
            }

            // 2) Aaj bhar chuke? → skip.
            if (hasSubmittedToday(user.internshipId)) {
                console.log(`[Reminder] ${user.name} already submitted — skip.`);
                continue;
            }

            // 3) Warna normal reminder bhejo.
            const reminderText =
                `⏰ *Attendance Reminder*\n\n` +
                `Hi ${user.name}! You haven't marked today's attendance yet. 📝\n\n` +
                `Just send your work description like:\n` +
                `*WORK: Worked on data preprocessing today*\n\n` +
                `I'll prepare your form link instantly.`;

            try {
                await client.sendMessage(user.id, reminderText);
                console.log(`[Reminder] Sent to ${user.name}.`);
            } catch (err) {
                console.error(`[Reminder] Failed for ${user.name}:`, err.message);
            }
        }
    }, {
        timezone: 'Asia/Kolkata'
    });
}

module.exports = { startReminders, markSubmittedToday, hasSubmittedToday };
