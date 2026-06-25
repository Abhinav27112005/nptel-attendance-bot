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

/**
 * Start the reminder scheduler.
 * @param {object} client       WhatsApp client (sendMessage)
 * @param {function} getTargets async () => [{ id, name, internshipId }, ...]
 */
function startReminders(client, getTargets) {
    console.log('[Reminder] Scheduler started — pings every 30 min from 5 PM to 11 PM IST.');

    cron.schedule('*/30 17-23 * * *', async () => {
        console.log(`[Reminder] ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — checking users...`);

        const targets = await getTargets();

        for (const user of targets) {
            if (hasSubmittedToday(user.internshipId)) {
                console.log(`[Reminder] ${user.name} already submitted — skip.`);
                continue;
            }

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
        // FIX: lock to IST so it fires at the right hour on any host (Render UTC, etc.)
        timezone: 'Asia/Kolkata'
    });
}

module.exports = { startReminders, markSubmittedToday, hasSubmittedToday };
