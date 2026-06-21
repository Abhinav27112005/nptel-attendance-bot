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
 * Ek mobile number ka profile dhoondho.
 * @param {string} whatsappId - "919835262809@c.us" ya "...@lid" ya sirf number
 * @returns {Promise<object|null>}
 */
async function getUserByMobile(whatsappId) {
    // @c.us / @lid hatao, sirf number rakho
    const number = String(whatsappId).replace('@c.us', '').replace('@lid', '').replace(/[+\s]/g, '');

    if (usingCloud()) {
        await connect();
        // MongoDB se number match karke profile lao
        return await _db.collection('users').findOne({ mobile: number });
    } else {
        // LOCAL: users/ folder ki har file padho, number match karo
        if (!fs.existsSync(USERS_DIR)) return null;
        const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const p = JSON.parse(fs.readFileSync(path.join(USERS_DIR, file), 'utf8'));
            if (p.mobile && p.mobile.replace(/[+\s]/g, '') === number) return p;
        }
        return null;
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

module.exports = { connect, usingCloud, getUserByMobile, getAllUsers };
