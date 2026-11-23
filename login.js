// Opens a real browser. Log in to Resy OS yourself (incl. 2FA).
// The session is saved automatically once you reach the portal Home page.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('https://os.resy.com/portal/ny/one40rooftop/Home');
  console.log('Log in in the browser window. It saves automatically when the Resy OS dashboard appears (up to 10 min)...');
  await page.waitForFunction(
    () => location.hostname === 'os.resy.com' && location.pathname.startsWith('/portal/') &&
          /Covers booked|Spread of Covers|Today,/i.test(document.body.innerText),
    null, { timeout: 600000, polling: 1000 });
  await page.waitForTimeout(2000);
  await ctx.storageState({ path: __dirname + '/session.json' });
  const n = (await ctx.cookies('https://os.resy.com')).length;
  console.log('Saved session.json (' + n + ' os.resy.com cookies)');
  await browser.close();
})();
