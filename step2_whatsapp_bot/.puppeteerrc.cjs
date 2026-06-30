// =============================================================================
// .puppeteerrc.cjs — Puppeteer ki Chrome cache location override karta hai.
//
// WHY THIS EXISTS:
//   Default cache: /opt/render/.cache/puppeteer (Render pe BUILD ke saath
//   delete ho jata hai — runtime tak survive nahi karta!).
//   Fix: cache ko PROJECT SOURCE folder ke andar rakho (runtime pe preserved).
//
// SAME CONFIG works on:
//   - Render (build phase mein download → runtime mein same path se launch)
//   - Heroku, Railway, Fly.io (same pattern)
//   - DigitalOcean (system Chromium use kare to PUPPETEER_EXECUTABLE_PATH set
//     karna; warna yeh path bhi chalega)
//   - Local dev (humara local Chrome bundle yahan save hoga, no problem)
//
// `__dirname` = jis folder mein yeh file hai (step2_whatsapp_bot/).
// Yeh path runtime aur build dono mein same resolve hoga.
// =============================================================================

const { join } = require('path');

module.exports = {
    cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
