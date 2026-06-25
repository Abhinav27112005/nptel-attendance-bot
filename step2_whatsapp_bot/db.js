// =============================================================================
// FILE: db.js
// PURPOSE: Ek "data layer" — users ka data MongoDB se ya local files se deta hai.
//
// LEARNING CONCEPT: Abstraction Layer
//   bot.js ko fikar nahi ki data kahan se aa raha (cloud ya file).
//   Woh bas getUserByMobile() bulata hai. db.js andar decide karta hai:
//     - .env mein MONGODB_URI hai? → MongoDB (cloud) se lo
//     - nahi? → local users/ folder se lo (purana tareeka, testing ke liye)
//   Isse local development aur cloud deployment DONO chalte hain — kuch toota nahi.
//
// LEARNING CONCEPT: Environment Variables (.env)
//   Secret cheezein (jaise database password) code mein nahi likhte.
//   Unhe .env file mein rakhte hain. dotenv library unhe process.env mein load karti hai.
//   Render pe deploy karte waqt yahi values "Environment Variables" mein daalte hain.
// =============================================================================

// .env file load karo (project root se — do level upar)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

// process.env se setting nikalo. .trim() = aage-peeche ke spaces hatao.
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const DB_NAME = 'attendanceauto';  // tumhare project ka naam
const USERS_DIR = path.join(__dirname, '..', 'users');

// Cloud use kar rahe hain ya local files?
// URI khaali ya placeholder ho to local mode.
function usingCloud() {
    return MONGODB_URI && !MONGODB_URI.includes('PASTE_YOUR');
}

// MongoDB connection ko ek baar banao, phir reuse karo (cache).
let _db = null;
async function connect() {
    if (usingCloud() && !_db) {
        const { MongoClient } = require('mongodb');
        const client = new MongoClient(MONGODB_URI);
        await client.connect();           // cloud se judo
        _db = client.db(DB_NAME);
        console.log('[DB] ✅ MongoDB se connected');
    }
    return _db;
}

/**
 * Profile dhoondho. Pehle whatsapp_id (full @c.us or @lid) ke base par,
 * phir mobile number ke base par (fallback for @c.us numbers).
 *
 * WHY two-step lookup?
 *   @lid users ka asli mobile WhatsApp Web API se reliably nikalta nahi.
 *   So jab woh "LINK SUM26..." command bhejte hain, hum unka @lid DB mein
 *   save karte hain (whatsapp_id field). Future messages mein @lid se hi
 *   lookup ho jata hai.
 *
 * @param {string} whatsappId - "919835262809@c.us" ya "243...@lid"
 */
async function getUserByMobile(whatsappId) {
    const fullId = String(whatsappId);           // e.g. "243...@lid"
    const numberOnly = fullId.replace('@c.us', '').replace('@lid', '').replace(/[+\s]/g, '');

    if (usingCloud()) {
        await connect();
        // $or: whatsapp_id match kare ya mobile match kare
        return await _db.collection('users').findOne({
            $or: [
                { whatsapp_id: fullId },
                { mobile: numberOnly }
            ]
        });
    } else {
        if (!fs.existsSync(USERS_DIR)) return null;
        const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const p = JSON.parse(fs.readFileSync(path.join(USERS_DIR, file), 'utf8'));
            if (p.whatsapp_id === fullId) return p;
            if (p.mobile && p.mobile.replace(/[+\s]/g, '') === numberOnly) return p;
        }
        return null;
    }
}

/**
 * User ke profile mein whatsapp_id (LID/cus) save karo — LINK command ke baad.
 * @param {string} internshipId - kaunsa profile update karna hai
 * @param {string} whatsappId   - user ka full @lid ya @c.us
 * @returns {Promise<boolean>}  - true if matched aur updated
 */
async function linkWhatsappId(internshipId, whatsappId) {
    if (usingCloud()) {
        await connect();
        const result = await _db.collection('users').updateOne(
            { internship_id: internshipId },
            { $set: { whatsapp_id: whatsappId } }
        );
        return result.matchedCount > 0;
    } else {
        if (!fs.existsSync(USERS_DIR)) return false;
        const filePath = path.join(USERS_DIR, internshipId + '.json');
        if (!fs.existsSync(filePath)) return false;
        const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        profile.whatsapp_id = whatsappId;
        fs.writeFileSync(filePath, JSON.stringify(profile, null, 2));
        return true;
    }
}

/**
 * Saare registered users ki list (reminders ke liye).
 * @returns {Promise<object[]>}
 */
async function getAllUsers() {
    if (usingCloud()) {
        await connect();
        return await _db.collection('users').find({}).toArray();
    } else {
        if (!fs.existsSync(USERS_DIR)) return [];
        return fs.readdirSync(USERS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8')));
    }
}

module.exports = { connect, usingCloud, getUserByMobile, getAllUsers, linkWhatsappId };
