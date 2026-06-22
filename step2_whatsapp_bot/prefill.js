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

// Form ka base URL (viewform tak)
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
    const [hour, minute] = timeStr.split(':');  // "09:45" → ["09","45"]
    // String mein wapas (padded 2-digit) — Google Forms time pre-fill ko
    // "09" chahiye, "9" nahi. parseInt karne se "09" → 9 ho jata tha.
    return {
        hour: String(parseInt(hour, 10)).padStart(2, '0'),     // "09"
        minute: String(parseInt(minute, 10)).padStart(2, '0')  // "45"
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
function buildPrefilledUrl(profile, natureOfWork, loginTime, logoutTime) {
    // URLSearchParams ek built-in tool hai jo query string safely banata hai.
    // Ye spaces, special characters (jaise "In-person", "Prof.") ko khud encode kar deta hai.
    // WHY important? Bina encoding ke "12 weeks" ka space URL todd dega.
    const params = new URLSearchParams();

    // usp=pp_url — Google ko batata hai "ye ek pre-filled link hai"
    params.append("usp", "pp_url");

    // --- Simple text/choice fields ---
    params.append(ENTRY.internshipId, profile.internship_id);
    params.append(ENTRY.name,         profile.name);
    params.append(ENTRY.mobile,       profile.mobile);
    params.append(ENTRY.institute,    profile.institute);
    params.append(ENTRY.professor,    profile.professor);
    params.append(ENTRY.mode,         profile.mode);       // dropdown: "In-person"
    params.append(ENTRY.duration,     profile.duration);   // radio: "12 weeks"
    params.append(ENTRY.natureOfWork, natureOfWork);

    // --- Start date (year/month/day alag) ---
    const sd = splitDate(profile.start_date);
    params.append(`${ENTRY.startDate}_year`,  sd.year);
    params.append(`${ENTRY.startDate}_month`, sd.month);
    params.append(`${ENTRY.startDate}_day`,   sd.day);

    // --- End date ---
    const ed = splitDate(profile.end_date);
    params.append(`${ENTRY.endDate}_year`,  ed.year);
    params.append(`${ENTRY.endDate}_month`, ed.month);
    params.append(`${ENTRY.endDate}_day`,   ed.day);

    // --- Login time (hour/minute alag) ---
    const lt = splitTime(loginTime);
    params.append(`${ENTRY.loginTime}_hour`,   lt.hour);
    params.append(`${ENTRY.loginTime}_minute`, lt.minute);

    // --- Logout time ---
    const ot = splitTime(logoutTime);
    params.append(`${ENTRY.logoutTime}_hour`,   ot.hour);
    params.append(`${ENTRY.logoutTime}_minute`, ot.minute);

    // Base URL + "?" + saare parameters jodo
    return `${FORM_BASE}?${params.toString()}`;
}

// bot.js use kar sake isliye export
module.exports = { buildPrefilledUrl };
