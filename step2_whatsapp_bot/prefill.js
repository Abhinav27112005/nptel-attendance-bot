// =============================================================================
// FILE: prefill.js
// PURPOSE: Ek "pre-filled" Google Form link banata hai — jisme saare jawaab
//          pehle se bhare hote hain. User bas tap karke, review karke submit kare.
//
// LEARNING CONCEPT: Pre-filled Form Link
//   Google Forms ek special URL format support karta hai jisme tum query
//   parameters ke through jawaab bhar sakte ho. Format:
//
//   .../viewform?usp=pp_url&entry.<ID>=<value>&entry.<ID2>=<value2>...
//
//   Har sawaal ka ek unique "entry ID" hota hai (jaise entry.774080877).
//   Ye IDs humne form inspect karke nikale the. Jab user is link ko khole,
//   form un values ke saath PEHLE SE BHARA hua dikhta hai.
//
//   WHY ye better hai server-side Chrome se?
//   - Form USER ke apne device (mobile) pe khulta hai, server pe nahi
//   - USER ke apne Gmail se khulta hai (jo unke phone mein logged-in hai)
//   - Koi Playwright/Chrome automation nahi chahiye — sirf ek URL
//   - 10 users ke liye natural — har koi apne phone pe
// =============================================================================

// Form ka base URL (viewform tak) — pre-filled LINK ke liye.
//
// IMPORTANT — BOT FORM KHUD SUBMIT NAHI KARTA (jaan-bujhke).
//   NPTEL ki attendance TABHI count hoti hai jab user apne registered Gmail se
//   submit kare. Server se anonymous submit karne pe attendance record nahi
//   hoti (stipend kat sakta hai). Isliye bot sirf pre-filled LINK deta hai —
//   user apne Chrome (registered Gmail) mein khol ke KHUD submit karta hai.
const FORM_BASE = "https://docs.google.com/forms/d/e/1FAIpQLSc3hc_MvzVLMGxsC9Dwb8vH_W793qeBaX8M18jcC8Oqu3q8gw/viewform";

// -----------------------------------------------------------------------------
// ENTRY ID MAP — har form field ka unique ID
// -----------------------------------------------------------------------------
// Ye IDs humne form ko inspect karke nikale (hidden inputs ke "name" se).
// Agar form badle to ye IDs badal sakte hain — tab dobara inspect karna padega.
const ENTRY = {
    internshipId: "entry.774080877",   // Internship ID
    name:         "entry.1427496382",  // Your Name
    mobile:       "entry.153567958",   // Mobile Number
    institute:    "entry.622274352",   // Institute
    professor:    "entry.902581063",   // Professor
    mode:         "entry.1778807467",  // Mode of Internship (dropdown)
    duration:     "entry.368649346",   // Duration (radio)
    natureOfWork: "entry.1606200858",  // Nature of work

    // Date fields — year/month/day alag-alag entry lete hain
    startDate:    "entry.801524043",   // + _year / _month / _day
    endDate:      "entry.1539493324",  // + _year / _month / _day

    // Time fields — hour/minute alag-alag entry lete hain
    loginTime:    "entry.1974825725",  // + _hour / _minute
    logoutTime:   "entry.1522358167",  // + _hour / _minute
};

// -----------------------------------------------------------------------------
// HELPER: "2026-05-19" ko {year, month, day} mein todo
// -----------------------------------------------------------------------------
// Date pre-fill ke liye Google ko year, month, day alag-alag chahiye.
// parseInt() leading zero hata deta hai: "05" → 5 (Google numbers expect karta hai).
function splitDate(dateStr) {
    const [year, month, day] = dateStr.split('-');  // "2026-05-19" → ["2026","05","19"]
    return {
        year: parseInt(year, 10),    // 2026
        month: parseInt(month, 10),  // 5
        day: parseInt(day, 10)       // 19
    };
}

// -----------------------------------------------------------------------------
// HELPER: "09:45" ko {hour, minute} mein todo
// -----------------------------------------------------------------------------
function splitTime(timeStr) {
    // "09:45" → hour=9, minute=45 (integer — Google Forms time pre-fill
    // requires plain numbers without leading zeros; padded "09" also fails).
    //
    // KNOWN LIMITATION: Google Forms time pre-fill via URL is UNRELIABLE —
    // works in some forms, fails in others (Google has never officially
    // documented support). Date pre-fill works reliably; time often doesn't.
    // Hum apni taraf se sahi format bhejte hain — agar form accept kare to
    // bhar jayega, warna user khud type karega (WhatsApp summary mein time
    // 12-hour format mein clearly dikhata hai backup ke liye).
    const [hour, minute] = timeStr.split(':');
    return {
        hour: parseInt(hour, 10),     // 9 (not "09" or "9")
        minute: parseInt(minute, 10)  // 45
    };
}

// -----------------------------------------------------------------------------
// MAIN FUNCTION: Pre-filled link banao
// -----------------------------------------------------------------------------
// Parameters:
//   profile       → user ka data (name, internshipId, etc.) JSON se
//   natureOfWork  → aaj ka kaam (WhatsApp message)
//   loginTime     → "HH:MM"
//   logoutTime    → "HH:MM"
// Returns: poora pre-filled URL (string)
// -----------------------------------------------------------------------------
// CORE: saare form fields ko URLSearchParams mein bharo (link + submit dono use karte)
// -----------------------------------------------------------------------------
function buildParams(profile, natureOfWork, loginTime, logoutTime) {
    const params = new URLSearchParams();

    params.append(ENTRY.internshipId, profile.internship_id);
    params.append(ENTRY.name,         profile.name);
    params.append(ENTRY.mobile,       profile.mobile);
    params.append(ENTRY.institute,    profile.institute);
    params.append(ENTRY.professor,    profile.professor);
    params.append(ENTRY.mode,         profile.mode);
    params.append(ENTRY.duration,     profile.duration);
    params.append(ENTRY.natureOfWork, natureOfWork);

    const sd = splitDate(profile.start_date);
    params.append(`${ENTRY.startDate}_year`,  sd.year);
    params.append(`${ENTRY.startDate}_month`, sd.month);
    params.append(`${ENTRY.startDate}_day`,   sd.day);

    const ed = splitDate(profile.end_date);
    params.append(`${ENTRY.endDate}_year`,  ed.year);
    params.append(`${ENTRY.endDate}_month`, ed.month);
    params.append(`${ENTRY.endDate}_day`,   ed.day);

    const lt = splitTime(loginTime);
    params.append(`${ENTRY.loginTime}_hour`,   lt.hour);
    params.append(`${ENTRY.loginTime}_minute`, lt.minute);

    const ot = splitTime(logoutTime);
    params.append(`${ENTRY.logoutTime}_hour`,   ot.hour);
    params.append(`${ENTRY.logoutTime}_minute`, ot.minute);

    return params;
}

// -----------------------------------------------------------------------------
// Pre-filled LINK banao (backup ke liye — agar direct submit fail ho)
// -----------------------------------------------------------------------------
function buildPrefilledUrl(profile, natureOfWork, loginTime, logoutTime) {
    const params = buildParams(profile, natureOfWork, loginTime, logoutTime);
    params.append("usp", "pp_url");
    return `${FORM_BASE}?${params.toString()}`;
}

// bot.js use kar sake isliye export
module.exports = { buildPrefilledUrl };
