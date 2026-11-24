const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const local = fs.existsSync(__dirname + '/config.json') ? JSON.parse(fs.readFileSync(__dirname + '/config.json')) : {};
const cfg = {
  webhookUrl: process.env.WEBHOOK_URL || local.webhookUrl,
  secret: process.env.SYNC_SECRET || local.secret,
  pages: JSON.parse(fs.readFileSync(__dirname + '/pages.json'))
};
if (!cfg.webhookUrl || !cfg.secret) { console.error('Missing WEBHOOK_URL / SYNC_SECRET'); process.exit(3); }

function notify(msg) {
  try { execSync(`osascript -e 'display notification "${msg}" with title "Resy sync"'`); } catch (e) {}
}

async function scrape(page) {
  return page.evaluate(() => {
    const txt = el => el.innerText.replace(/\s+/g, ' ').trim();
    const out = [];
    document.querySelectorAll('table').forEach((t, i) => {
      const heading = (t.closest('section,div')?.querySelector('h1,h2,h3,h4')?.innerText || `table${i + 1}`).trim();
      const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(txt));
      if (rows.length) out.push({ heading, rows });
    });
    return out;
  });
}

(async () => {
  if (!fs.existsSync(__dirname + '/session.json')) { notify('No session. Run: npm run login'); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: __dirname + '/session.json' });
  const page = await ctx.newPage();
  for (const p of cfg.pages) {
   try {
    await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/login|signin|auth/i.test(page.url())) {
      notify('Resy session expired. Run: npm run login'); await browser.close(); process.exit(2);
    }
    await page.waitForSelector('table, [role=row]', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const tables = await scrape(page);
    if (!tables.length) {
      const frames = page.frames().map(f => f.url()).filter(u => u !== 'about:blank').slice(0, 5);
      const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 300);
      console.log(p.name, 'NO TABLES; frames', JSON.stringify(frames), 'text:', text);
      continue;
    }
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: cfg.secret, page: p.name, scrapedAt: new Date().toISOString(), tables })
    });
    const body = (await res.text()).slice(0, 80); console.log(p.name, tables.length, 'tables ->', res.status, body);
    if (p.discover) {
      const links = await page.$$eval('a[href]', as => [...new Set(as.map(a => a.getAttribute('href')))].filter(h => /portal\/.+\/(analytics|reports?|guests?)/i.test(h)));
      console.log('LINKS', JSON.stringify(links));
    }
   } catch (e) { console.log(p.name, 'FAILED', String(e).slice(0, 120)); }
  }
  await ctx.storageState({ path: __dirname + '/session.json' }); // refresh cookies
  await browser.close();
})();
