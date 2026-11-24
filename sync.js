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

const NOISE = /^(Chart|Chart annotations summary|End of interactive chart\.|(Bar|Pie|Line|Column|Area) chart.*|The chart has .*|Results are in .*)$/i;
async function scrapeHome(page) {
  await page.waitForFunction(() => /Covers booked/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  let last = -1, stable = 0;
  for (let i = 0; i < 15 && stable < 3; i++) {
    await page.waitForTimeout(2000);
    const n = await page.evaluate(() => document.body.innerText.length);
    stable = n === last ? stable + 1 : 0; last = n;
  }
  const lines = await page.evaluate(() => (document.querySelector('main') || document.body).innerText.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean));
  const SECTIONS = ['Spread of Covers', 'Upcoming Covers', 'Recent Survey Comments'];
  const first = lines.findIndex(x => SECTIONS.includes(x));
  const top = lines.slice(0, first < 0 ? lines.length : first).filter(x => !/^View /i.test(x));
  const dateIdx = top.findIndex(x => /^Today,/i.test(x));
  const kpi = top.slice(dateIdx + 1);
  const out = [];
  const pairs = [];
  for (let i = 0; i + 1 < kpi.length; i += 2) pairs.push([kpi[i], kpi[i + 1]]);
  if (pairs.length) out.push({ heading: 'Today Summary', rows: [['Metric', 'Value'], ...pairs] });
  if (first >= 0) SECTIONS.forEach((name, si) => {
    const start = lines.indexOf(name); if (start < 0) return;
    const ends = SECTIONS.map(n => lines.indexOf(n)).filter(i => i > start);
    const body = lines.slice(start + 1, ends.length ? Math.min(...ends) : lines.length);
    if (name === 'Spread of Covers') {
      const times = body.filter(x => /^\d{1,2}:\d{2}$/.test(x)), caps = body.filter(x => /^\d+\/\d+$/.test(x));
      if (times.length && times.length === caps.length) { out.push({ heading: name, rows: [['Time', 'Covers / Capacity'], ...times.map((t, i) => [t, caps[i]])] }); return; }
    }
    if (body.length) out.push({ heading: name, rows: body.map(x => [x]) });
  });
  return out;
}

async function scrapeTiles(page) {
  const f = page.frames().find(f => /looker/.test(f.url()));
  if (!f) return [];
  let last = -1, stable = 0;
  for (let i = 0; i < 30 && stable < 4; i++) {
    await page.waitForTimeout(3000);
    const n = await f.evaluate(() => document.querySelectorAll('[class*="tile" i], [data-testid*="tile" i]').length + ':' + document.body.innerText.length).catch(() => '');
    stable = n === last && !/^0:/.test(n) ? stable + 1 : 0; last = n;
  }
  return f.evaluate((NOISE_SRC) => {
    const NOISE = new RegExp(NOISE_SRC, 'i');
    const clean = t => t.split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const txt = e => e.innerText.replace(/\s+/g, ' ').trim();
    const real = [...document.querySelectorAll('[data-testid="styled-tile-dashboard"]')];
    if (real.length) {
      const res = [];
      real.forEach((t, i) => {
        const titleEl = t.querySelector('[data-testid="dashboard-tile-title"]');
        let title = titleEl ? txt(titleEl).slice(0, 100) : '';
        const heads = [...t.querySelectorAll('.ag-header-cell')];
        const rowEls = [...t.querySelectorAll('.ag-row')];
        if (heads.length && rowEls.length) {
          const ids = heads.map(h => h.getAttribute('col-id'));
          const header = heads.map(h => txt(h.querySelector('.column-label') || h));
          const byIdx = {};
          rowEls.forEach(r => { const k = r.getAttribute('row-index') ?? r.getAttribute('row-id'); (byIdx[k] = byIdx[k] || []).push(...r.querySelectorAll('.ag-cell')); });
          const rows = Object.keys(byIdx).sort((x, y) => x - y).map(k => {
            const m = {}; byIdx[k].forEach(c => { m[c.getAttribute('col-id')] = txt(c); });
            return ids.map(id => m[id] ?? '');
          });
          res.push({ heading: title, rows: [header, ...rows] });
        } else {
          const l = clean(t.innerText).filter(x => !/^tile actions$/i.test(x) && !NOISE.test(x) && x !== title);
          if (!title && l.length > 1) title = l.shift();
          if (l.length) res.push({ heading: title || `tile${i + 1}`, rows: l.map(x => [x]) });
        }
      });
      if (res.length) return res;
    }
    const tiles = [...document.querySelectorAll('[class*="tile" i], [data-testid*="tile" i], [class*="dashboard-element" i]')]
      .filter(el => !el.querySelector('[class*="tile" i], [data-testid*="tile" i], [class*="dashboard-element" i]'));
    const out = tiles.map((el, i) => { const l = clean(el.innerText).filter(x => !/^tile actions$/i.test(x)); return l.length > 1 ? { heading: l[0] || `tile${i + 1}`, rows: l.slice(1).map(x => [x]) } : null; }).filter(Boolean);
    if (out.length) return out;
    const l = clean(document.body.innerText);
    return l.length > 1 ? [{ heading: 'Dashboard text', rows: l.map(x => [x]) }] : [];
  }, NOISE.source).catch(() => []);
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
    let tables = [];
    for (let attempt = 1; attempt <= (p.minTables ? 3 : 1); attempt++) {
      await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (/login|signin|auth/i.test(page.url())) {
        notify('Resy session expired. Run: npm run login'); await browser.close(); process.exit(2);
      }
      await page.waitForSelector('table, [role=row]', { timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(2000);
      let t = p.home ? await scrapeHome(page) : await scrape(page);
      if (!t.length && p.tiles) t = await scrapeTiles(page);
      if (t.length > tables.length) tables = t;
      if (!p.minTables || tables.length >= p.minTables) break;
      console.log(p.name, 'attempt', attempt, 'got', t.length, 'of at least', p.minTables, '- retrying');
    }
    if (p.minTables && tables.length < p.minTables) {
      console.log(p.name, 'INCOMPLETE (' + tables.length + ' < ' + p.minTables + '), skipped so the Sheet keeps its last full snapshot');
      continue;
    }
    if (!tables.length) {
      console.log(p.name, 'NO TABLES');
      continue;
    }
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: cfg.secret, page: p.name, scrapedAt: new Date().toISOString(), tables })
    });
    const raw = await res.text(); const body = raw.startsWith('ok') ? 'ok' : 'RESPONSE: ' + raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400); console.log(p.name, tables.length, 'tables ->', res.status, body);
    if (p.discover) {
      const links = await page.$$eval('a[href]', as => [...new Set(as.map(a => a.getAttribute('href')))].filter(h => /portal\/.+\/(analytics|reports?|guests?)/i.test(h)));
      console.log('LINKS', JSON.stringify(links));
    }
   } catch (e) { console.log(p.name, 'FAILED', String(e).slice(0, 120)); }
  }
  await ctx.storageState({ path: __dirname + '/session.json' }); // refresh cookies
  await browser.close();
})();
