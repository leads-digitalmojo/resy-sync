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

async function scrapeTiles(page) {
  const f = page.frames().find(f => /looker/.test(f.url()));
  if (!f) return [];
  await f.waitForFunction(() => document.body.innerText.length > 400 && !/loading/i.test(document.body.innerText.slice(0, 200)), null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(8000);
  return f.evaluate(() => {
    const clean = t => t.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const tiles = [...document.querySelectorAll('[class*="tile" i], [data-testid*="tile" i], [class*="dashboard-element" i]')]
      .filter(el => !el.querySelector('[class*="tile" i], [data-testid*="tile" i], [class*="dashboard-element" i]'));
    const out = tiles.map((el, i) => { const l = clean(el.innerText); return l.length ? { heading: l[0] || `tile${i + 1}`, rows: l.slice(1).map(x => [x]) } : null; }).filter(Boolean);
    if (out.length) return out;
    const l = clean(document.body.innerText);
    return l.length ? [{ heading: 'Dashboard text', rows: l.map(x => [x]) }] : [];
  }).catch(() => []);
}

async function scrape(page) {
  const all = [];
  for (const f of page.frames()) {
    if (f.url() === 'about:blank' || /stripe|kustomer|site\.com/.test(f.url())) continue;
    if (f !== page.mainFrame()) await f.waitForSelector('table, [role=row], [role=gridcell]', { timeout: 20000 }).catch(() => {});
    all.push(...await f.evaluate(() => {
    const txt = el => el.innerText.replace(/\s+/g, ' ').trim();
    const out = [];
    document.querySelectorAll('table').forEach((t, i) => {
      const heading = (t.closest('section,div')?.querySelector('h1,h2,h3,h4')?.innerText || `table${i + 1}`).trim();
      const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(txt));
      if (rows.length) out.push({ heading, rows });
    });
    return out;
  }).catch(() => []));
  }
  return all;
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
    await page.waitForSelector('table, [role=row]', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2000);
    let tables = await scrape(page);
    if (!tables.length && p.tiles) { tables = await scrapeTiles(page); console.log(p.name, 'TILES', JSON.stringify(tables).slice(0, 600)); }
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
