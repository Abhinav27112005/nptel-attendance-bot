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
        // FAST-FAIL timeouts — weak phone/network pe operations hang na hon.
        // Bina inke koi query minute-bhar atak sakti thi (bot "processing" pe stuck).
        const client = new MongoClient(MONGODB_URI, {
            serverSelectionTimeoutMS: 8000,   // server dhoondhne ka max 8s
            connectTimeoutMS: 8000,           // connect ka max 8s
            socketTimeoutMS: 20000,           // ek operation ka max 20s
        });
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

// Short links 30 minutes ke liye valid rehte hain.
// WHY safety: pre-filled URL mein user ka mobile aur saari details hoti hain.
// Agar link kahin leak ho jaye, expiry ke baad woh kisi kaam ki nahi.
const SHORTLINK_TTL_MS = 30 * 60 * 1000;  // 30 min in milliseconds

// One-time setup: MongoDB ko bolo "expires_at field 0 second baad delete kar do".
// expireAfterSeconds: 0 = "exact time at expires_at pe delete". MongoDB har minute
// check karta hai aur expired docs hata deta hai — auto cleanup, hum kuch nahi karte.
let _ttlIndexReady = false;
async function ensureTtlIndex() {
    if (_ttlIndexReady || !usingCloud()) return;
    await connect();
    try {
        await _db.collection('shortlinks').createIndex(
            { expires_at: 1 },
            { expireAfterSeconds: 0, name: 'expires_at_ttl' }
        );
        _ttlIndexReady = true;
    } catch (e) {
        // Index already exists with same/different options — non-fatal
        console.log('[DB] TTL index note:', e.message);
        _ttlIndexReady = true;
    }
}

/**
 * Short link banao aur DB mein save karo. 30 min ke baad apne aap expire.
 * @param {string} fullUrl       — Google Forms ka pura pre-filled URL
 * @param {string} internshipId  — kis user ne banaya
 * @returns {Promise<{shortId, expiresAt}|null>}
 */
async function saveShortLink(fullUrl, internshipId) {
    if (!usingCloud()) return null;
    await connect();
    await ensureTtlIndex();
    const shortId = Math.random().toString(36).slice(2, 8);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHORTLINK_TTL_MS);
    await _db.collection('shortlinks').insertOne({
        short_id: shortId,
        full_url: fullUrl,
        internship_id: internshipId,
        clicks: 0,
        created_at: now,
        expires_at: expiresAt
    });
    return { shortId, expiresAt };
}

/**
 * Daily link counter — kis user ne aaj kitne link banaye + last time.
 * Reminder marking ke alag se rakhte hain (yeh "kitne baar tried"; reminder "submit ho gaya assume").
 */
async function recordLinkGenerated(internshipId) {
    if (!usingCloud()) return { todayCount: 1, lastAt: new Date() };
    await connect();
    const today = new Date().toISOString().slice(0, 10);  // "2026-06-22"
    const res = await _db.collection('link_stats').findOneAndUpdate(
        { internship_id: internshipId, date: today },
        { $inc: { count: 1 }, $set: { last_at: new Date() } },
        { upsert: true, returnDocument: 'after' }
    );
    const doc = res?.value || res;  // mongo driver versions ka diff
    return {
        todayCount: doc?.count || 1,
        lastAt: doc?.last_at || new Date()
    };
}

async function getLinkStats(internshipId) {
    if (!usingCloud()) return null;
    await connect();
    const today = new Date().toISOString().slice(0, 10);
    return await _db.collection('link_stats').findOne({
        internship_id: internshipId, date: today
    });
}

module.exports = {
    connect, usingCloud, getUserByMobile, getAllUsers, linkWhatsappId,
    saveShortLink, recordLinkGenerated, getLinkStats
};
