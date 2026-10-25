/**
 * אנליטיקה פנימית - בית הבירה אקספרס
 *
 * POST /analytics/events   - ציבורי (עם הגבלת קצב). מקבל אירועים אנונימיים מהאפליקציה ושומר אותם
 *                            ב-analytics/{branch}/ev/{YYYY-MM-DD}/{eventId}. מזהה האירוע = מפתח -> אין כפילויות.
 * GET  /analytics/summary  - למנהל בלבד (requireApiKey: מפתח API או טוקן Firebase של המנהל). מחזיר סיכומים בלבד.
 *
 * פרטיות: לא נשמרים טלפון / אימייל / שם / כתובת / IP. מזהה מבקר הוא מחרוזת אקראית שנוצרת בדפדפן.
 * שמירה: אירועים נמחקים אוטומטית אחרי RETENTION_DAYS ימים.
 * כללי Firebase לא משתנים: הנתיב analytics סגור לקריאה/כתיבה מהדפדפן (ברירת המחדל של השורש), רק השרת ניגש אליו.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');

const RETENTION_DAYS = 180;
const ABANDON_MIN = 30; // סל ללא הזמנה שהושלמה במשך 30 דקות = נטוש
const TZ = 'Asia/Jerusalem';
const TYPES = new Set(['visit', 'screen', 'pv', 'search', 'add', 'rem', 'cv', 'ck', 'oa', 'os', 'of', 'err', 'img', 'perf', 'inst']);
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayKey(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function hourOf(ts) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(ts))) % 24;
}
function weekdayOf(ts) {
  const d = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date(ts));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(d);
}
function addDays(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
const str = (v, n) => (v == null ? undefined : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : undefined);
// לא שומרים רצפי ספרות ארוכים (טלפון/כרטיס) ולא כתובות מייל, גם אם הוקלדו בטעות בחיפוש או נכנסו להודעת שגיאה
const scrub = (s) => (s == null ? undefined : String(s).replace(/\S+@\S+/g, '[email]').replace(/\d[\d\s-]{7,}\d/g, '[num]'));

function cleanEvent(e, now) {
  if (!e || typeof e !== 'object') return null;
  const id = String(e.id || '');
  const t = String(e.t || '');
  if (!ID_RE.test(id) || !TYPES.has(t)) return null;
  const v = String(e.v || ''), s = String(e.s || '');
  if (!ID_RE.test(v) || !ID_RE.test(s)) return null;
  let ts = Number(e.ts) || now;
  if (ts > now + 5 * 60e3 || ts < now - 24 * 3600e3) ts = now; // שעון דפדפן לא אמין - מגבילים
  const o = { t, ts, v, s };
  const put = (k, val) => { if (val !== undefined && val !== '' && val !== null) o[k] = val; };
  put('bc', str(e.bc, 40));
  put('q', str(scrub(e.q), 40));
  put('n', num(e.n));
  put('qty', num(e.qty));
  put('val', num(e.val));
  put('items', num(e.items));
  put('sc', str(e.sc, 20));
  put('src', str(scrub(e.src), 60));
  put('dev', str(e.dev, 10));
  put('br', str(e.br, 12));
  put('pwa', e.pwa ? 1 : undefined);
  put('nv', e.nv ? 1 : undefined);
  put('adm', e.adm ? 1 : undefined);
  put('oid', ID_RE.test(String(e.oid || '')) ? String(e.oid) : undefined);
  put('msg', str(scrub(e.msg), 160));
  put('ms', num(e.ms));
  put('u', str(e.u, 160));
  return { id, o };
}

let lastCleanup = 0;
async function cleanupOld(db, branch) {
  if (Date.now() - lastCleanup < 6 * 3600e3) return;
  lastCleanup = Date.now();
  const cutoff = addDays(dayKey(Date.now()), -RETENTION_DAYS);
  const snap = await db.ref(`analytics/${branch}/ev`).orderByKey().endAt(cutoff).limitToFirst(10).once('value');
  const upd = {};
  snap.forEach((c) => { upd[c.key] = null; });
  if (Object.keys(upd).length) await db.ref(`analytics/${branch}/ev`).update(upd);
}

// ---------- מונה שגיאות שרת (5xx) לפי יום - בלי פרטים אישיים ----------
function serverErrorCounter(db) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 500 && !String(req.path || '').startsWith('/analytics')) {
        const route = String(req.path || '').replace(/[.#$[\]/]/g, '_').slice(0, 40) || '_';
        db.ref(`analyticsServerErrors/${dayKey(Date.now())}/${route}`).transaction((c) => (Number(c) || 0) + 1).catch(() => {});
      }
    });
    next();
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}
const top = (obj, n = 15) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

// ---------- חישוב סיכום לטווח ----------
async function loadEvents(db, branch, days) {
  const all = [];
  await Promise.all(days.map(async (d) => {
    const v = (await db.ref(`analytics/${branch}/ev/${d}`).once('value')).val() || {};
    Object.values(v).forEach((e) => { if (e) all.push(e); });
  }));
  // ביקור שבו המנהל היה מחובר (גם אם רק חלק מהאירועים סומנו - ההתחברות נטענת אחרי תחילת הביקור) לא נספר בכלל
  const admSessions = new Set(all.filter((e) => e.adm).map((e) => e.s));
  const admVisitors = new Set(all.filter((e) => e.adm).map((e) => e.v));
  return all.filter((e) => !admSessions.has(e.s) && !admVisitors.has(e.v));
}

function computeTraffic(evs) {
  const sessions = new Map();
  for (const e of evs) {
    let s = sessions.get(e.s);
    if (!s) { s = { v: e.v, first: e.ts, last: e.ts, ev: [] }; sessions.set(e.s, s); }
    s.first = Math.min(s.first, e.ts); s.last = Math.max(s.last, e.ts); s.ev.push(e);
  }
  const visitors = new Set(), newVisitors = new Set();
  const byHour = Array(24).fill(0), byWeekday = Array(7).fill(0), byDay = {};
  const src = {}, dev = {}, br = {};
  let pwaSessions = 0; const durations = [];
  for (const s of sessions.values()) {
    visitors.add(s.v);
    const visit = s.ev.find((e) => e.t === 'visit') || s.ev[0];
    if (visit.nv) newVisitors.add(s.v);
    byHour[hourOf(s.first)]++; byWeekday[weekdayOf(s.first)]++;
    const dk = dayKey(s.first); byDay[dk] = (byDay[dk] || 0) + 1;
    const sk = visit.src || 'ישיר'; src[sk] = (src[sk] || 0) + 1;
    if (visit.dev) dev[visit.dev] = (dev[visit.dev] || 0) + 1;
    if (visit.br) br[visit.br] = (br[visit.br] || 0) + 1;
    if (s.ev.some((e) => e.pwa)) pwaSessions++;
    durations.push(Math.min(2 * 3600e3, s.last - s.first));
  }
  const screens = {};
  evs.filter((e) => e.t === 'screen').forEach((e) => { screens[e.sc || '?'] = (screens[e.sc || '?'] || 0) + 1; });
  return {
    sessions, visits: sessions.size, visitors: visitors.size, newVisitors: newVisitors.size,
    returningVisitors: Math.max(0, visitors.size - newVisitors.size),
    byHour, byWeekday, byDay, sources: top(src, 20), devices: top(dev), browsers: top(br),
    pwaSessions, installs: evs.filter((e) => e.t === 'inst').length, screens: top(screens, 20),
    avgSessionSec: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000) : 0,
    medianSessionSec: Math.round(median(durations) / 1000),
  };
}

function computeFunnel(sessions, validOrderIds, now) {
  const steps = { visit: 0, pv: 0, add: 0, cv: 0, ck: 0, oa: 0, os: 0 };
  const ab = { count: 0, value: 0, items: 0, stage: { cart: 0, checkout: 0, attempt: 0 }, inProgress: 0 };
  const failReasons = {};
  let unconfirmed = 0;
  for (const s of sessions.values()) {
    const has = (t) => s.ev.some((e) => e.t === t);
    const success = s.ev.some((e) => e.t === 'os' && e.oid && validOrderIds.has(e.oid));
    if (s.ev.some((e) => e.t === 'os') && !success) unconfirmed++;
    // משפך מצטבר: מי שהגיע לשלב מאוחר נחשב כמי שעבר גם את השלבים שלפניו (למשל מעבר ישיר מפס הסל לקופה)
    const order = ['pv', 'add', 'cv', 'ck', 'oa'];
    let reached = -1;
    order.forEach((t, i) => { if (has(t)) reached = i; });
    if (success) reached = order.length;
    steps.visit++;
    order.forEach((t, i) => { if (reached >= i) steps[t]++; });
    if (success) steps.os++;
    s.ev.filter((e) => e.t === 'of').forEach((e) => { const k = e.msg || 'לא ידוע'; failReasons[k] = (failReasons[k] || 0) + 1; });
    if (reached >= 1 && !success) { // היה סל (הוספה, צפייה בסל או קופה)
      const lastCartEv = s.ev.filter((e) => ['add', 'rem', 'cv', 'ck', 'oa'].includes(e.t)).sort((a, b) => a.ts - b.ts).pop();
      if (now - s.last < ABANDON_MIN * 60e3) { ab.inProgress++; continue; } // עדיין פעיל - לא נטוש
      const lastVal = s.ev.filter((e) => e.val != null).sort((a, b) => a.ts - b.ts).pop();
      if (lastVal && lastVal.val <= 0) continue; // רוקן את הסל בעצמו
      ab.count++;
      if (lastVal) { ab.value += lastVal.val || 0; ab.items += lastVal.items || 0; }
      const stage = has('oa') ? 'attempt' : has('ck') ? 'checkout' : 'cart';
      ab.stage[stage]++;
      void lastCartEv;
    }
  }
  ab.value = Math.round(ab.value * 100) / 100;
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    steps,
    rates: { pv: rate(steps.pv, steps.visit), add: rate(steps.add, steps.pv), cv: rate(steps.cv, steps.add), ck: rate(steps.ck, steps.cv), oa: rate(steps.oa, steps.ck), os: rate(steps.os, steps.oa), overall: rate(steps.os, steps.visit) },
    cartAbandonRate: rate(ab.count, ab.count + steps.os),
    checkoutAbandonRate: rate(ab.stage.checkout + ab.stage.attempt, ab.stage.checkout + ab.stage.attempt + steps.os), // רק סלים שנחשבים נטושים (לא פעילים)
    abandoned: ab, abandonWindowMin: ABANDON_MIN, failReasons: top(failReasons, 10), unconfirmedClientSuccess: unconfirmed,
  };
}

function computeProducts(evs, orders, retail) {
  const pv = {}, add = {}, buy = {}, catPv = {}, catAdd = {}, catBuy = {};
  const cat = (bc) => (retail[bc] && retail[bc].category) || 'לא ידוע';
  evs.forEach((e) => {
    if (e.t === 'pv' && e.bc) { pv[e.bc] = (pv[e.bc] || 0) + 1; catPv[cat(e.bc)] = (catPv[cat(e.bc)] || 0) + 1; }
    if (e.t === 'add' && e.bc) { add[e.bc] = (add[e.bc] || 0) + 1; catAdd[cat(e.bc)] = (catAdd[cat(e.bc)] || 0) + 1; }
  });
  orders.filter((o) => o.status !== 'cancelled').forEach((o) => (o.items || []).forEach((it) => {
    const q = it.weighed ? 1 : Number(it.qty) || 0;
    buy[it.barcode] = (buy[it.barcode] || 0) + q; catBuy[cat(it.barcode)] = (catBuy[cat(it.barcode)] || 0) + q;
  }));
  const nm = (bc) => (retail[bc] && retail[bc].name) || bc;
  const row = ([bc, n]) => ({ bc, name: nm(bc), n, pv: pv[bc] || 0, add: add[bc] || 0, buy: buy[bc] || 0 });
  const searches = {}, zero = {};
  evs.filter((e) => e.t === 'search' && e.q).forEach((e) => {
    const k = e.q.trim().toLowerCase(); searches[k] = (searches[k] || 0) + 1; if (!e.n) zero[k] = (zero[k] || 0) + 1;
  });
  const smoke = /טבק|סיגר|נרגיל|גחלים|מצת|פילטר|ניירות|גלגול|סיגריות|אייקוס|iqos/i;
  const missingImg = Object.entries(retail).filter(([bc, v]) => v && v.name && v.price > 0 && v.inStock !== false && !v.image && !smoke.test((v.category || '') + ' ' + v.name)).map(([bc, v]) => ({ bc, name: v.name, category: v.category }));
  const imgErr = {};
  evs.filter((e) => e.t === 'img').forEach((e) => { const k = e.bc || e.u || '?'; imgErr[k] = (imgErr[k] || 0) + 1; });
  return {
    topViewed: top(pv).map(row), topAdded: top(add).map(row), topBought: top(buy).map(row),
    categories: Object.keys({ ...catPv, ...catAdd, ...catBuy }).map((c) => ({ c, pv: catPv[c] || 0, add: catAdd[c] || 0, buy: catBuy[c] || 0 })).sort((a, b) => b.pv + b.add * 3 + b.buy * 5 - (a.pv + a.add * 3 + a.buy * 5)).slice(0, 25),
    viewedNotBought: Object.entries(pv).filter(([bc, n]) => n >= 3 && !buy[bc]).sort((a, b) => b[1] - a[1]).slice(0, 15).map(row),
    topSearches: top(searches, 20), zeroResultSearches: top(zero, 20),
    missingImages: missingImg.slice(0, 100), missingImagesCount: missingImg.length,
    imageErrors: top(imgErr, 20).map(([k, n]) => ({ k, name: nm(k), n })),
  };
}

function computeSales(orders, allOrders) {
  const groups = { open: 0, cancelled: 0, completed: 0 };
  const byDay = {}, byHour = Array(24).fill(0), byStatus = {};
  let revenue = 0, valid = 0, items = 0;
  const phoneCount = {};
  allOrders.forEach((o) => { if (o.customerPhone) phoneCount[o.customerPhone] = (phoneCount[o.customerPhone] || 0) + 1; });
  const repeatPhones = new Set();
  for (const o of orders) {
    const st = o.status || 'new';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const g = st === 'cancelled' ? 'cancelled' : (st === 'collected' || st === 'completed' || st === 'done') ? 'completed' : 'open';
    groups[g]++;
    if (g === 'cancelled') continue;
    valid++; revenue += Number(o.totalAmount) || 0; items += Number(o.totalItems) || 0;
    const dk = dayKey(o.createdAt);
    byDay[dk] = byDay[dk] || { orders: 0, revenue: 0 };
    byDay[dk].orders++; byDay[dk].revenue = Math.round((byDay[dk].revenue + (Number(o.totalAmount) || 0)) * 100) / 100;
    byHour[hourOf(o.createdAt)]++;
    if (o.customerPhone && phoneCount[o.customerPhone] > 1) repeatPhones.add(o.customerPhone);
  }
  const customers = new Set(orders.filter((o) => o.status !== 'cancelled' && o.customerPhone).map((o) => o.customerPhone));
  return {
    orders: orders.length, validOrders: valid, revenue: Math.round(revenue * 100) / 100,
    avgBasket: valid ? Math.round((revenue / valid) * 100) / 100 : 0, avgItems: valid ? Math.round((items / valid) * 10) / 10 : 0,
    groups, byStatus, byDay, byHour, customers: customers.size, repeatCustomers: repeatPhones.size,
    clubOrders: orders.filter((o) => o.clubMemberPhone && o.status !== 'cancelled').length,
    campaignOrders: orders.filter((o) => o.campaignId && o.status !== 'cancelled').length,
  };
}

function computeErrors(evs, srvErrByDay, days) {
  const js = {}, ck = {}, byDay = {};
  days.forEach((d) => { byDay[d] = { js: 0, checkout: 0, img: 0, server: 0 }; });
  const loads = [];
  evs.forEach((e) => {
    const d = dayKey(e.ts); const b = byDay[d] || (byDay[d] = { js: 0, checkout: 0, img: 0, server: 0 });
    if (e.t === 'err') { js[e.msg || '?'] = (js[e.msg || '?'] || 0) + 1; b.js++; }
    if (e.t === 'of') { ck[e.msg || '?'] = (ck[e.msg || '?'] || 0) + 1; b.checkout++; }
    if (e.t === 'img') b.img++;
    if (e.t === 'perf' && e.ms > 0 && e.ms < 120000) loads.push(e.ms);
  });
  Object.entries(srvErrByDay || {}).forEach(([d, routes]) => {
    if (!byDay[d]) return;
    byDay[d].server = Object.values(routes || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  });
  return {
    jsErrors: top(js, 15), checkoutFailures: top(ck, 10), byDay,
    loadMsMedian: Math.round(median(loads)), loadMsP90: loads.length ? Math.round([...loads].sort((a, b) => a - b)[Math.floor(loads.length * 0.9)]) : 0, loadSamples: loads.length,
  };
}

function registerAnalytics(app, { db, requireApiKey, VALID_BRANCHES }) {
  const evLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'rate' } });

  app.post('/analytics/events', evLimiter, express.text({ type: '*/*', limit: '64kb' }), async (req, res) => {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'json' }); } }
      const branch = String((body && body.b) || '');
      if (!VALID_BRANCHES.includes(branch)) return res.status(400).json({ error: 'branch' });
      const list = Array.isArray(body.ev) ? body.ev.slice(0, 40) : [];
      const now = Date.now();
      const upd = {};
      let n = 0;
      for (const raw of list) {
        const c = cleanEvent(raw, now);
        if (!c) continue;
        upd[`${dayKey(c.o.ts)}/${c.id}`] = c.o; // מזהה אירוע כמפתח - שליחה חוזרת דורסת את אותה רשומה, לא יוצרת כפילות
        n++;
      }
      if (n) await db.ref(`analytics/${branch}/ev`).update(upd);
      res.status(204).end();
      cleanupOld(db, branch).catch(() => {});
    } catch (err) {
      console.error('POST /analytics/events error:', err.message);
      res.status(204).end(); // אנליטיקה לעולם לא מפריעה ללקוח
    }
  });

  app.get('/analytics/summary', requireApiKey, async (req, res) => {
    try {
      const branch = String(req.query.branch || 'shfayim');
      if (!VALID_BRANCHES.includes(branch)) return res.status(400).json({ error: 'branch לא תקף' });
      const today = dayKey(Date.now());
      const to = DAY_RE.test(String(req.query.to)) ? String(req.query.to) : today;
      const from = DAY_RE.test(String(req.query.from)) ? String(req.query.from) : to;
      if (from > to) return res.status(400).json({ error: 'טווח תאריכים לא תקין' });
      const days = daysBetween(from, to);
      if (days.length > 92) return res.status(400).json({ error: 'טווח מקסימלי 92 ימים' });
      const prevDays = daysBetween(addDays(from, -days.length), addDays(from, -1));
      const now = Date.now();

      const [evs, prevEvs, ordersObj, retail, srvErr] = await Promise.all([
        loadEvents(db, branch, days),
        loadEvents(db, branch, prevDays),
        db.ref(`pickupOrders/${branch}`).once('value').then((s) => s.val() || {}),
        db.ref(`retail/${branch}`).once('value').then((s) => s.val() || {}),
        db.ref('analyticsServerErrors').orderByKey().startAt(prevDays[0] || from).endAt(to).once('value').then((s) => s.val() || {}),
      ]);
      const allOrders = Object.entries(ordersObj).map(([id, o]) => ({ id, ...o })).filter((o) => o && o.createdAt && !o.qaTest);
      const inRange = (o, ds) => ds.includes(dayKey(o.createdAt));
      const orders = allOrders.filter((o) => inRange(o, days));
      const prevOrders = allOrders.filter((o) => inRange(o, prevDays));
      const validIds = new Set(allOrders.map((o) => o.id));

      const traffic = computeTraffic(evs);
      const prevTraffic = computeTraffic(prevEvs);
      const funnel = computeFunnel(traffic.sessions, validIds, now);
      const prevFunnel = computeFunnel(prevTraffic.sessions, validIds, now);
      const sales = computeSales(orders, allOrders);
      const prevSales = computeSales(prevOrders, allOrders);
      const errors = computeErrors(evs, srvErr, days);
      const prevErrors = computeErrors(prevEvs, srvErr, prevDays);
      delete traffic.sessions; delete prevTraffic.sessions;

      // התראות: עלייה חריגה בתקלות ביום האחרון בטווח לעומת ממוצע הימים הקודמים
      const alerts = [];
      const tot = (b) => (b ? b.js + b.checkout + b.server : 0);
      const lastDay = days[days.length - 1];
      const hist = [...prevDays, ...days.slice(0, -1)].slice(-7).map((d) => tot(errors.byDay[d] || prevErrors.byDay[d]));
      const avg = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
      const lastTot = tot(errors.byDay[lastDay]);
      if (lastTot >= 5 && lastTot > avg * 3) alerts.push({ level: 'high', text: `עלייה חריגה בתקלות ב-${lastDay}: ${lastTot} לעומת ממוצע ${avg.toFixed(1)} ביום` });
      if (errors.checkoutFailures.length) alerts.push({ level: 'mid', text: `כשלי שליחת הזמנה בטווח: ${errors.checkoutFailures.reduce((a, b) => a + b[1], 0)}` });
      if (funnel.unconfirmedClientSuccess) alerts.push({ level: 'mid', text: `${funnel.unconfirmedClientSuccess} הזמנות שדווחו כהצלחה בדפדפן אך לא נמצאו בשרת` });

      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true, branch, from, to, days: days.length, prevFrom: prevDays[0], prevTo: prevDays[prevDays.length - 1],
        generatedAt: now, eventsCount: evs.length, retentionDays: RETENTION_DAYS, timezone: TZ,
        traffic, prevTraffic: { visits: prevTraffic.visits, visitors: prevTraffic.visitors, newVisitors: prevTraffic.newVisitors },
        funnel, prevFunnel: { steps: prevFunnel.steps, rates: prevFunnel.rates, cartAbandonRate: prevFunnel.cartAbandonRate },
        sales, prevSales: { validOrders: prevSales.validOrders, revenue: prevSales.revenue, avgBasket: prevSales.avgBasket, groups: prevSales.groups },
        products: computeProducts(evs, orders, retail),
        errors, prevErrorsTotal: Object.values(prevErrors.byDay).reduce((a, b) => a + tot(b), 0), alerts,
      });
    } catch (err) {
      console.error('GET /analytics/summary error:', err.message);
      res.status(500).json({ error: 'שגיאה בחישוב הנתונים' });
    }
  });
}

module.exports = { registerAnalytics, serverErrorCounter, _test: { cleanEvent, computeFunnel, computeTraffic, dayKey } };
