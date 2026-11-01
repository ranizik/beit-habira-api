/**
 * תכל׳ס בלי Google: כניסה כ"אורח" (רק שם), ואפשרות לחבר חשבון Google מאוחר יותר
 *   POST /tasks/guest/start        { name }                        -> { ok, token }   חשבון חדש בלי מייל, נשמר במכשיר
 *   POST /tasks/guest/link         { credential } + Bearer (אורח)  -> { ok, token, merged }   חיבור לחשבון Google (חלון קופץ)
 *   POST /tasks/guest/link-ticket  Bearer (אורח)                   -> { ok, ticket }  כרטיס חתום לחיבור במעבר לגוגל וחזרה (אייפון / אפליקציה מותקנת)
 *   POST /tasks/guest/link-redirect (טופס מגוגל; הכרטיס בתוך ה-nonce) -> חזרה לאפליקציה #ct=...&n=...&lnk=1
 * חיבור ל-Google:
 *   - אם למייל הזה עוד אין חשבון: האורח פשוט מקבל את המייל - אותו חשבון, אותן משימות.
 *   - אם כבר יש חשבון Google כזה: המשימות והרשימות המשותפות של האורח מועתקות אליו, והכניסה עוברת לחשבון הזה.
 */
const crypto = require('crypto');

const SAFE = /^[-_A-Za-z0-9]{1,128}$/;
const CLIENT_ID = process.env.GCAL_CLIENT_ID || '895106923239-7ctgh1gc0je4pah4egj0t8h2ajapo95c.apps.googleusercontent.com';
const TICKET_MS = 15 * 60000;

function register(app, admin, db, express) {
  const secret = crypto.createHash('sha256').update(String(process.env.FIREBASE_KEY || '') + '|tasks-guest').digest();
  const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url').slice(0, 32);
  const makeTicket = (uid) => { const p = Buffer.from(uid + '|' + (Date.now() + TICKET_MS)).toString('base64url'); return p + '.' + sign(p); };
  const readTicket = (t) => {
    const [p, sig] = String(t || '').split('.');
    if (!p || !sig || sig.length !== 32 || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(p)))) return null;
    const [uid, exp] = Buffer.from(p, 'base64url').toString().split('|');
    return SAFE.test(uid) && Number(exp) > Date.now() ? uid : null;
  };
  const hits = {};
  const limited = (key, max, ms) => { const now = Date.now(); const a = (hits[key] || []).filter((t) => now - t < ms); a.push(now); hits[key] = a; return a.length > max; };
  const appUrl = () => require('./tasksAdmin').APP_URL;

  async function authUser(req) {
    const h = req.headers.authorization || '';
    const d = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return d && SAFE.test(d.uid) ? d : null;
  }
  async function verifyGoogle(cred) {
    if (!cred || typeof cred !== 'string' || cred.length > 4096) return null;
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred));
    const p = await r.json().catch(() => ({}));
    if (!r.ok || p.aud !== CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(p.iss)) return null;
    if (String(p.email_verified) !== 'true' || !p.email || Number(p.exp) * 1000 < Date.now()) return null;
    return p;
  }
  // אורח = חשבון בלי מייל (ולא של מערכת ההזמנות / בעל העסק)
  async function guestRecord(uid) {
    if (!uid || uid.startsWith('staff-')) return null;
    const u = await admin.auth().getUser(uid).catch(() => null);
    return u && !u.email ? u : null;
  }

  async function linkGuest(uid, p) {
    const email = String(p.email).toLowerCase();
    const existing = await admin.auth().getUserByEmail(email).catch(() => null);
    if (existing && existing.uid.startsWith('staff-')) throw new Error('חשבון לא תקין');
    if (!existing) {
      const g = await admin.auth().getUser(uid);
      await admin.auth().updateUser(uid, { email, emailVerified: true, displayName: g.displayName || p.name || undefined });
      await db.ref(`todoAccess/users/${uid}`).update({ email, guest: null }).catch(() => {});
      return { uid, merged: false };
    }
    // יש כבר חשבון Google - מעבירים אליו את המשימות והרשימות של האורח (בלי לדרוס משימות קיימות)
    const to = existing.uid;
    const [tasks, myLists] = await Promise.all([`todo/users/${uid}/tasks`, `todo/userLists/${uid}`].map((x) => db.ref(x).once('value').then((s) => s.val() || {})));
    const upd = {};
    const have = (await db.ref(`todo/users/${to}/tasks`).once('value')).val() || {};
    Object.entries(tasks).forEach(([id, t]) => { if (t && SAFE.test(id) && !have[id]) upd[`todo/users/${to}/tasks/${id}`] = t; });
    for (const listId of Object.keys(myLists).filter((x) => SAFE.test(x))) {
      const m = (await db.ref(`todo/shared/${listId}/members/${uid}`).once('value')).val();
      if (!m) continue;
      upd[`todo/shared/${listId}/members/${to}`] = { ...m, name: existing.displayName || m.name || '' };
      upd[`todo/userLists/${to}/${listId}`] = myLists[listId];
    }
    upd[`todoAccess/users/${uid}/mergedInto`] = to;
    if (Object.keys(upd).length) await db.ref().update(upd);
    return { uid: to, merged: true };
  }

  app.post('/tasks/guest/start', express.json(), async (req, res) => {
    try {
      if (limited('s:' + req.ip, 5, 3600000) || limited('s:all', 200, 86400000)) return res.status(429).json({ error: 'יותר מדי הרשמות, נסה שוב מאוחר יותר' });
      const name = String((req.body || {}).name || '').replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (name.length < 2) return res.status(400).json({ error: 'כתוב את השם שלך' });
      const u = await admin.auth().createUser({ displayName: name });
      await db.ref(`todoGuests/${u.uid}`).set({ name, created: Date.now() });
      res.json({ ok: true, token: await admin.auth().createCustomToken(u.uid) });
    } catch (err) {
      console.error('POST /tasks/guest/start error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/guest/link', express.json(), async (req, res) => {
    try {
      if (limited('l:' + req.ip, 10, 60000)) return res.status(429).json({ error: 'יותר מדי ניסיונות' });
      const d = await authUser(req);
      if (!d || !(await guestRecord(d.uid))) return res.status(400).json({ error: 'החשבון כבר מחובר ל-Google' });
      const p = await verifyGoogle((req.body || {}).credential);
      if (!p) return res.status(401).json({ error: 'האימות מול Google נכשל' });
      const r = await linkGuest(d.uid, p);
      res.json({ ok: true, merged: r.merged, token: await admin.auth().createCustomToken(r.uid) });
    } catch (err) {
      console.error('POST /tasks/guest/link error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/guest/link-ticket', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d || !(await guestRecord(d.uid))) return res.status(400).json({ error: 'החשבון כבר מחובר ל-Google' });
      res.json({ ok: true, ticket: makeTicket(d.uid) });
    } catch (err) {
      console.error('POST /tasks/guest/link-ticket error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/guest/link-redirect', express.urlencoded({ extended: false }), async (req, res) => {
    const back = (hash) => res.redirect(303, appUrl() + '#' + hash);
    try {
      if (limited('l:' + req.ip, 10, 60000)) return back('lerr=' + encodeURIComponent('יותר מדי ניסיונות'));
      const p = await verifyGoogle((req.body || {}).credential);
      if (!p) return back('lerr=' + encodeURIComponent('האימות מול Google נכשל'));
      const uid = readTicket(p.nonce); // הכרטיס החתום של האורח נשלח לגוגל בתוך ה-nonce וחוזר חתום בתוך האישור
      if (!uid || !(await guestRecord(uid))) return back('lerr=' + encodeURIComponent('הקישור פג תוקף - נסה שוב'));
      const r = await linkGuest(uid, p);
      back('ct=' + encodeURIComponent(await admin.auth().createCustomToken(r.uid)) + '&n=' + encodeURIComponent(p.nonce) + '&lnk=' + (r.merged ? '2' : '1'));
    } catch (err) {
      console.error('POST /tasks/guest/link-redirect error:', err.message);
      back('lerr=' + encodeURIComponent('שגיאת שרת'));
    }
  });
}

module.exports = { register };
