/**
 * תזכורות Push לאפליקציית המשימות (beit-habira.com/tasks)
 * - רישום מכשיר: POST /tasks/push-register  (Authorization: Bearer <idToken>)  body: { token, deviceId }
 * - בדיקה כל דקה: לכל משימה פתוחה עם תאריך נשלחות 2 תזכורות:
 *     1. ב-20:00 בערב שלפני   2. בשעת המשימה (אם הוגדרה שעה)
 *   ההתראה מגיעה גם כשהאפליקציה סגורה. כל משתמש מקבל רק על המשימות שלו.
 * - מה שכבר נשלח נשמר במשימה בשדה rem: { k: "<date>|<time>", eve, at } - שינוי תאריך/שעה מאפס.
 */
const TZ = 'Asia/Jerusalem';
const SAFE = /^[-_A-Za-z0-9]{1,128}$/;
const MAX_LATE_MS = 6 * 60 * 60 * 1000; // לא שולחים תזכורת שאיחרה ביותר מ-6 שעות (למשל אחרי השבתה ארוכה)

// שעה מקומית בישראל -> זמן אמיתי (UTC ms), כולל שעון קיץ/חורף
function ilTime(dateStr, timeStr) {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = String(timeStr || '00:00').split(':').map(Number);
  if (!y || !mo || !d || isNaN(h) || isNaN(mi)) return NaN;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIL = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess - (asIL - guess);
}

// מצב בריאות לבדיקה עצמית (tasksHealth.js קורא אותו)
const health = { startedAt: Date.now(), lastTickAt: 0, lastOkAt: 0, consecutiveErr: 0, lastError: '', sendOk: 0, sendFail: 0 };

function register(app, admin, db, express) {
  async function authUser(req) {
    const h = req.headers.authorization || '';
    const decoded = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return decoded && SAFE.test(decoded.uid) ? decoded : null;
  }
  const displayName = (d) => String(d.uid === 'staff-tasks' ? 'רני' : (d.name || (d.email || '').split('@')[0] || 'משתמש')).slice(0, 40);
  const randomCode = () => require('crypto').randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  // יומן פעילות של רשימה משותפת: מי הצטרף / יצא / צורף ע"י מי
  const logList = (listId, ev) => db.ref(`todo/shared/${listId}/log`).push({ ...ev, at: Date.now() }).catch(() => {});

  // ---------- רשימות משותפות: יצירה / הצטרפות בקישור / יציאה ----------
  // todo/shared/<listId> = { name, owner, invite, created, members: { uid: { name, at } }, tasks: {...} }
  // todo/userLists/<uid>/<listId> = true  (אינדקס - אילו רשימות משותפות יש למשתמש)
  // הכתיבה ל-members/invite נעשית רק כאן (בשרת), כך שאי אפשר להצטרף לרשימה בלי קישור הזמנה תקף
  app.post('/tasks/lists/create', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const name = String((req.body || {}).name || '').trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: 'חסר שם לרשימה' });
      const count = Object.keys((await db.ref(`todo/userLists/${d.uid}`).once('value')).val() || {}).length;
      if (count >= 30) return res.status(400).json({ error: 'יותר מדי רשימות' });
      const ref = db.ref('todo/shared').push();
      const invite = randomCode();
      await ref.set({ name, owner: d.uid, invite, created: Date.now(), members: { [d.uid]: { name: displayName(d), at: Date.now() } } });
      await db.ref(`todo/userLists/${d.uid}/${ref.key}`).set(true);
      await logList(ref.key, { type: 'create', uid: d.uid, name: displayName(d) });
      res.json({ ok: true, listId: ref.key, invite });
    } catch (err) {
      console.error('POST /tasks/lists/create error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/lists/join', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { listId, invite } = req.body || {};
      if (!SAFE.test(String(listId || '')) || !invite) return res.status(400).json({ error: 'קישור לא תקין' });
      const list = (await db.ref(`todo/shared/${listId}`).once('value')).val();
      if (!list || !list.invite || String(invite) !== String(list.invite)) return res.status(404).json({ error: 'הקישור לא תקף או שהרשימה נמחקה' });
      const already = !!(list.members && list.members[d.uid]);
      if (!already) {
        // מכסת משתתפים לפי המסלול של בעל הרשימה (מי שכבר ברשימה נשאר)
        const limit = await require('./tasksAccess').memberLimit(db, list.owner).catch(() => Infinity);
        const count = Object.keys(list.members || {}).length;
        if (count >= limit) {
          if (list.owner && list.owner !== d.uid) await sendToUser(list.owner, '👥 ' + (list.name || 'רשימה משותפת') + ' – הרשימה מלאה', displayName(d) + ' ניסה/תה להצטרף, אבל הגעת ל-' + limit + ' משתתפים. אפשר להוסיף מקומות – פנה/י לרני', 'list-' + listId).catch(() => 0);
          return res.status(403).json({ error: 'הרשימה מלאה (' + limit + ' משתתפים). בעל/ת הרשימה יכול/ה להוסיף מקומות.', full: true });
        }
        await db.ref(`todo/shared/${listId}/members/${d.uid}`).set({ name: displayName(d), at: Date.now(), via: 'link' });
        await logList(listId, { type: 'join', uid: d.uid, name: displayName(d) });
        if (list.owner && list.owner !== d.uid) await sendToUser(list.owner, '👥 ' + (list.name || 'רשימה משותפת'), displayName(d) + ' הצטרף/ה לרשימה', 'list-' + listId).catch(() => 0);
      }
      await db.ref(`todo/userLists/${d.uid}/${listId}`).set(true);
      res.json({ ok: true, listId, name: list.name });
    } catch (err) {
      console.error('POST /tasks/lists/join error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // התראה לשאר חברי רשימה משותפת כשמישהו מוסיף משימה ("נוגה הוסיפה: ...")
  const notifyHits = {};
  app.post('/tasks/lists/notify', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { listId } = req.body || {};
      const name = String((req.body || {}).name || '').trim().slice(0, 120);
      if (!SAFE.test(String(listId || '')) || !name) return res.status(400).json({ error: 'חסרים פרטים' });
      const now = Date.now();
      const hits = (notifyHits[d.uid] || []).filter((t) => now - t < 3600000);
      if (hits.length >= 60) return res.json({ ok: false, error: 'יותר מדי התראות' });
      hits.push(now); notifyHits[d.uid] = hits;
      const list = (await db.ref(`todo/shared/${listId}`).once('value')).val();
      if (!list || !list.members || !list.members[d.uid]) return res.status(403).json({ error: 'לא חבר ברשימה' });
      const who = (list.members[d.uid] && list.members[d.uid].name) || displayName(d);
      // assignee = מי שהמשימה באחריותו (מקבל/ת התראה מיוחדת). reassign = רק שינוי אחריות - בלי "הוסיף/ה" לשאר
      const assignee = SAFE.test(String((req.body || {}).assignee || '')) && list.members[req.body.assignee] ? req.body.assignee : '';
      const reassign = !!(req.body || {}).reassign;
      const others = Object.keys(list.members).filter((u) => u !== d.uid && SAFE.test(u));
      let sent = 0;
      for (const u of others) {
        if (u === assignee) sent += await sendToUser(u, '📌 ' + (list.name || 'רשימה משותפת') + ' – באחריותך', who + ': ' + name, 'list-' + listId);
        else if (!reassign) sent += await sendToUser(u, '👥 ' + (list.name || 'רשימה משותפת'), who + ' הוסיף/ה: ' + name + (assignee && list.members[assignee] ? ' (באחריות ' + (list.members[assignee].name || '') + ')' : ''), 'list-' + listId);
      }
      res.json({ ok: true, sent });
    } catch (err) {
      console.error('POST /tasks/lists/notify error:', err.message);
      res.status(200).json({ ok: false });
    }
  });

  app.post('/tasks/lists/leave', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { listId } = req.body || {};
      if (!SAFE.test(String(listId || ''))) return res.status(400).json({ error: 'רשימה לא תקינה' });
      const lv = (await db.ref(`todo/shared/${listId}`).once('value')).val();
      const wasMember = !!(lv && lv.members && lv.members[d.uid]);
      await db.ref(`todo/shared/${listId}/members/${d.uid}`).remove();
      await db.ref(`todo/userLists/${d.uid}/${listId}`).remove();
      if (wasMember) {
        await logList(listId, { type: 'leave', uid: d.uid, name: (lv.members[d.uid] && lv.members[d.uid].name) || displayName(d) });
        if (lv.owner && lv.owner !== d.uid && lv.members[lv.owner]) await sendToUser(lv.owner, '👥 ' + (lv.name || 'רשימה משותפת'), ((lv.members[d.uid] && lv.members[d.uid].name) || displayName(d)) + ' יצא/ה מהרשימה', 'list-' + listId).catch(() => 0);
      }
      // הרשימה עצמה לא נמחקת לעולם (גם כשכולם יצאו) - כדי שלא יאבדו משימות בטעות
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/lists/leave error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // מחיקת משימות מרשימה משותפת דרך השרת (כל חבר ברשימה יכול למחוק)
  app.post('/tasks/lists/remove-tasks', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { listId, ids } = req.body || {};
      if (!SAFE.test(String(listId || '')) || !Array.isArray(ids) || !ids.length || ids.length > 500) return res.status(400).json({ error: 'חסרים פרטים' });
      const member = (await db.ref(`todo/shared/${listId}/members/${d.uid}`).once('value')).val();
      if (!member) return res.status(403).json({ error: 'לא חבר ברשימה' });
      const upd = {};
      ids.filter((id) => SAFE.test(String(id))).forEach((id) => { upd[id] = null; });
      if (!Object.keys(upd).length) return res.status(400).json({ error: 'אין משימות' });
      await db.ref(`todo/shared/${listId}/tasks`).update(upd);
      res.json({ ok: true, removed: Object.keys(upd).length });
    } catch (err) {
      console.error('POST /tasks/lists/remove-tasks error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // ---------- פרטי רשימה: משתתפים, פעילות, יומן הצטרפות/יציאה ----------
  app.post('/tasks/lists/info', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const { listId } = req.body || {};
      if (!SAFE.test(String(listId || ''))) return res.status(400).json({ error: 'רשימה לא תקינה' });
      const list = (await db.ref(`todo/shared/${listId}`).once('value')).val();
      if (!list || !list.members || !list.members[d.uid]) return res.status(403).json({ error: 'לא חבר ברשימה' });
      const stats = (await db.ref('todoStats/users').once('value')).val() || {};
      const tasks = Object.values(list.tasks || {}).filter(Boolean);
      const members = Object.entries(list.members).filter(([u, m]) => SAFE.test(u) && m).map(([uid, m]) => {
        const mine = tasks.filter((t) => t.byUid === uid || (!t.byUid && t.by && t.by === m.name));
        const lastTask = mine.reduce((a, t) => Math.max(a, Number(t.created) || 0, Number(t.doneAt) || 0), 0);
        return {
          uid, name: m.name || 'חבר/ה', at: m.at || null, by: m.byName || '', via: m.via || (uid === list.owner ? 'owner' : ''),
          owner: uid === list.owner, me: uid === d.uid,
          lastSeen: Math.max((stats[uid] || {}).last || 0, lastTask) || null,
          added: mine.length,
          assignedOpen: tasks.filter((t) => !t.done && t.who && t.who.uid === uid).length,
        };
      }).sort((a, b) => (b.owner - a.owner) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
      const log = Object.values(list.log || {}).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 40);
      res.json({ ok: true, name: list.name, count: members.length, members, log, tasks: tasks.length, open: tasks.filter((t) => !t.done).length });
    } catch (err) {
      console.error('POST /tasks/lists/info error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // אנשי קשר = מי שכבר נמצא איתי ברשימה משותפת כלשהי (אפשר לצרף אותם ישר, בלי קישור)
  async function myContacts(uid) {
    const ids = Object.keys((await db.ref(`todo/userLists/${uid}`).once('value')).val() || {}).filter((x) => SAFE.test(x));
    const out = {};
    for (const id of ids) {
      const m = (await db.ref(`todo/shared/${id}/members`).once('value')).val() || {};
      for (const [u, v] of Object.entries(m)) if (u !== uid && SAFE.test(u) && v) out[u] = out[u] || { uid: u, name: v.name || 'חבר/ה' };
    }
    return out;
  }
  app.post('/tasks/lists/contacts', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const c = await myContacts(d.uid);
      res.json({ ok: true, contacts: Object.values(c).sort((a, b) => String(a.name).localeCompare(String(b.name), 'he')) });
    } catch (err) {
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // צירוף ישיר לרשימה (בלי קישור): איש קשר קיים, או משתמש מאושר של האפליקציה לפי מייל
  const addHits = {};
  app.post('/tasks/lists/add', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const now = Date.now();
      const hits = (addHits[d.uid] || []).filter((t) => now - t < 3600000);
      if (hits.length >= 40) return res.json({ ok: false, error: 'יותר מדי צירופים - נסה שוב מאוחר יותר' });
      hits.push(now); addHits[d.uid] = hits;
      const { listId } = req.body || {};
      if (!SAFE.test(String(listId || ''))) return res.status(400).json({ error: 'רשימה לא תקינה' });
      const list = (await db.ref(`todo/shared/${listId}`).once('value')).val();
      if (!list || !list.members || !list.members[d.uid]) return res.status(403).json({ error: 'לא חבר ברשימה' });
      let target = null, tName = '';
      const contacts = await myContacts(d.uid);
      if (req.body.uid && contacts[req.body.uid]) { target = req.body.uid; tName = contacts[target].name; }
      else if (req.body.email) {
        const email = String(req.body.email).trim().toLowerCase().slice(0, 200);
        const u = await admin.auth().getUserByEmail(email).catch(() => null);
        if (u) {
          const acc = (await db.ref(`todoAccess/users/${u.uid}`).once('value')).val();
          const isOwnerAcc = ['ranizik@gmail.com'].includes(email);
          if (isOwnerAcc || (acc && !acc.pending && !acc.locked)) { target = u.uid; tName = u.displayName || (acc && acc.name) || email.split('@')[0]; }
        }
        if (!target) return res.json({ ok: false, error: 'לא מצאתי משתמש פעיל בתכל׳ס עם המייל הזה. שלח לו קישור הזמנה במקום.' });
      } else return res.status(400).json({ error: 'חסר משתמש' });
      if (list.members[target]) return res.json({ ok: true, already: true, name: tName });
      const limit = await require('./tasksAccess').memberLimit(db, list.owner).catch(() => Infinity);
      if (Object.keys(list.members).length >= limit) return res.json({ ok: false, full: true, error: 'הרשימה מלאה (' + limit + ' משתתפים). כדי להוסיף מקומות – פנה/י לרני.' });
      const byName = (list.members[d.uid] && list.members[d.uid].name) || displayName(d);
      await db.ref(`todo/shared/${listId}/members/${target}`).set({ name: String(tName).slice(0, 40), at: now, by: d.uid, byName, via: 'added' });
      await db.ref(`todo/userLists/${target}/${listId}`).set(true);
      await logList(listId, { type: 'add', uid: target, name: tName, by: d.uid, byName });
      await sendToUser(target, '👥 צורפת לרשימה "' + (list.name || 'רשימה משותפת') + '"', byName + ' צירף/ה אותך. אפשר לצאת מהרשימה בכל רגע.', 'list-' + listId).catch(() => 0);
      res.json({ ok: true, name: tName });
    } catch (err) {
      console.error('POST /tasks/lists/add error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  app.post('/tasks/push-register', express.json(), async (req, res) => {
    try {
      const decoded = await authUser(req);
      if (!decoded) return res.status(401).json({ error: 'אין הרשאה' });
      const { token, deviceId } = req.body || {};
      if (!token || typeof token !== 'string' || token.length > 4096 || !SAFE.test(String(deviceId || ''))) {
        return res.status(400).json({ error: 'token ו-deviceId חובה' });
      }
      await db.ref(`todoPushTokens/${decoded.uid}/${deviceId}`).set({ token, at: Date.now() });
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/push-register error:', err.message);
      res.status(200).json({ ok: false, error: err.message });
    }
  });

  async function sendToUser(uid, title, body, taskId, extra) {
    const snap = await db.ref(`todoPushTokens/${uid}`).once('value');
    const entries = Object.entries(snap.val() || {}).filter(([, v]) => v && v.token);
    if (!entries.length) return 0;
    const result = await admin.messaging().sendEachForMulticast({
      tokens: entries.map(([, v]) => v.token),
      notification: { title, body },
      data: { type: 'task-reminder', taskId: String(taskId), link: '/tasks/', ...(extra || {}) },
      webpush: { fcmOptions: { link: 'https://beit-habira.com/tasks/' }, headers: { Urgency: 'high', TTL: '21600' } },
    });
    const cleanup = {};
    result.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') cleanup[entries[i][0]] = null;
    });
    if (Object.keys(cleanup).length) await db.ref(`todoPushTokens/${uid}`).update(cleanup);
    health.sendOk += result.successCount;
    health.sendFail += result.responses.filter((r) => r.error && !/not-registered|invalid-registration/.test(r.error.code || '')).length;
    return result.successCount;
  }
  module.exports.sendToUser = sendToUser; // גם למודול המנויים (tasksAccess)

  // ---------- נודניק: משימה עם שעה שלא בוצעה - תזכורת חוזרת כל X דקות עד שמסמנים בוצע ----------
  // הגדרה למשתמש: todoNag/<uid> = { mode: 'all'|'urgent'|'off', every: 5|10|15|30 }  (ברירת מחדל: כל המשימות, כל 5 דקות)
  // בהתראה: כפתורי "✅ בוצע" ו"⏰ עוד 30 דק׳" - עובדים בלי לפתוח את האפליקציה (טוקן חתום למשימה)
  const NAG_DEFAULT = { mode: 'all', every: 5 };
  const NAG_WINDOW_MS = 24 * 3600 * 1000, NAG_MAX = 120;
  const crypto = require('crypto');
  const nagSecret = crypto.createHash('sha256').update(String(process.env.FIREBASE_KEY || '') + '|tasks-nag').digest();
  const signTask = (path, id) => { const p = Buffer.from(path + '|' + id).toString('base64url'); return p + '.' + crypto.createHmac('sha256', nagSecret).update(p).digest('base64url').slice(0, 32); };
  const verifyTask = (tok) => { const [p, sig] = String(tok || '').split('.'); if (!p || !sig) return null; const exp = crypto.createHmac('sha256', nagSecret).update(p).digest('base64url').slice(0, 32); if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null; const [path, id] = Buffer.from(p, 'base64url').toString().split('|'); return /^todo\/(tasks|users\/[-_A-Za-z0-9]+\/tasks|shared\/[-_A-Za-z0-9]+\/tasks)$/.test(path) && SAFE.test(id) ? { path, id } : null; };
  const ilHour = (ts) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit' }).format(new Date(ts)));
  const quiet = (ts) => { const h = ilHour(ts); return h >= 22 || h < 7; }; // לא מציקים בלילה
  function nextRepeatDate(t) {
    const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: TZ }) + 'T00:00:00Z');
    const d = new Date((t.date || today.toISOString().slice(0, 10)) + 'T00:00:00Z');
    const step = () => { if (t.rep === 'daily') d.setUTCDate(d.getUTCDate() + 1); else if (t.rep === 'weekly') d.setUTCDate(d.getUTCDate() + 7); else d.setUTCMonth(d.getUTCMonth() + 1); };
    step(); let g = 0; while (d < today && g++ < 400) step();
    return d.toISOString().slice(0, 10);
  }

  app.post('/tasks/nag/settings', express.json(), async (req, res) => {
    try {
      const d = await authUser(req);
      if (!d) return res.status(401).json({ error: 'אין הרשאה' });
      const ref = db.ref(`todoNag/${d.uid}`);
      const b = req.body || {};
      if (b.mode !== undefined || b.every !== undefined) {
        const upd = {};
        if (['all', 'urgent', 'off'].includes(b.mode)) upd.mode = b.mode;
        if ([5, 10, 15, 30].includes(Number(b.every))) upd.every = Number(b.every);
        await ref.update(upd);
      }
      res.json({ ok: true, ...NAG_DEFAULT, ...((await ref.once('value')).val() || {}) });
    } catch (err) {
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // לחיצה על כפתור בהתראה (מה-Service Worker, בלי התחברות - הטוקן חתום למשימה אחת)
  app.post('/tasks/nag/act', express.json(), async (req, res) => {
    try {
      const { t, a } = req.body || {};
      const v = verifyTask(t);
      if (!v || !['done', 'snooze'].includes(a)) return res.status(400).json({ error: 'לא תקין' });
      const ref = db.ref(`${v.path}/${v.id}`);
      const task = (await ref.once('value')).val();
      if (!task) return res.json({ ok: true, gone: true });
      if (a === 'snooze') { await ref.child('rem/snooze').set(Date.now() + 30 * 60000); return res.json({ ok: true }); }
      if (!task.done) {
        await ref.update({ done: true, doneAt: Date.now() });
        if (task.rep) { // משימה חוזרת - יוצרים את הפעם הבאה (כמו באפליקציה)
          const nid = 'task_' + Date.now();
          const n = { id: nid, name: task.name, pri: task.pri || 'low', date: nextRepeatDate(task), time: task.time || '', done: false, created: Date.now(), rep: task.rep };
          ['cat', 'notes', 'by', 'byUid', 'who'].forEach((k) => { if (task[k]) n[k] = task[k]; });
          await db.ref(`${v.path}/${nid}`).set(n);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/nag/act error:', err.message);
      res.status(500).json({ error: 'שגיאת שרת' });
    }
  });

  // uids = מי מקבל את התזכורת (משתמש אחד ברשימה פרטית, כל החברים ברשימה משותפת)
  async function checkUser(uids, tasksPath, tasks, now, prefix, nagCfg) {
    if (!Array.isArray(uids)) uids = [uids];
    const send = async (title, body, id) => { for (const u of uids) await sendToUser(u, title, body, id); };
    for (const [id, t] of Object.entries(tasks || {})) {
      if (!t || t.done || !t.date || !SAFE.test(id)) continue;
      const k = t.date + '|' + (t.time || '');
      const rem = t.rem && t.rem.k === k ? t.rem : { k };
      const upd = {};

      const [y, mo, d] = t.date.split('-').map(Number);
      const prev = new Date(Date.UTC(y, mo - 1, d - 1));
      const eveAt = ilTime(prev.toISOString().slice(0, 10), '20:00');
      const taskAt = t.time ? ilTime(t.date, t.time) : NaN;

      // ערב לפני - רק אם המשימה נוצרה לפני 20:00 של ערב קודם (לא שולחים "תזכורת למחר" על משימה שנוספה עכשיו להיום)
      if (!rem.eve && now >= eveAt && now - eveAt < MAX_LATE_MS && (!t.created || t.created < eveAt)) {
        upd.eve = true;
        await send('📋 תזכורת למחר: ' + (prefix || '') + t.name, 'מחר' + (t.time ? ' בשעה ' + t.time : ''), id);
      }
      const act = { act: signTask(tasksPath, id) };
      if (t.time && !rem.at && now >= taskAt && now - taskAt < MAX_LATE_MS) {
        upd.at = true; upd.atAt = now;
        for (const u of uids) await sendToUser(u, '⏰ הגיע הזמן: ' + (prefix || '') + t.name, 'עכשיו - ' + t.time, id, act);
      }
      // נודניק: ברשימה משותפת - רק למי שהמשימה באחריותו; ברשימה פרטית - לבעלים
      const nagTo = t.who && t.who.uid && uids.includes(t.who.uid) ? [t.who.uid] : (uids.length === 1 ? uids : []);
      const cfg = { ...NAG_DEFAULT, ...((nagCfg || {})[nagTo[0]] || {}) };
      const lastNag = rem.nagAt || rem.atAt || taskAt;
      if (t.time && rem.at && !upd.at && nagTo.length && cfg.mode !== 'off' && (cfg.mode !== 'urgent' || t.pri === 'high')
          && now - taskAt < NAG_WINDOW_MS && (rem.nagN || 0) < NAG_MAX && now >= (rem.snooze || 0)
          && now - lastNag >= cfg.every * 60000 && !quiet(now)) {
        upd.nagAt = now; upd.nagN = (rem.nagN || 0) + 1;
        const mins = Math.round((now - taskAt) / 60000);
        for (const u of nagTo) await sendToUser(u, '🔁 עדיין לא בוצע: ' + (prefix || '') + t.name, 'נקבע ל-' + t.time + ' (לפני ' + (mins < 60 ? mins + ' דק׳' : Math.round(mins / 60) + ' שע׳') + '). סמן ✅ בוצע כדי להפסיק', id, act);
      }
      if (Object.keys(upd).length) await db.ref(`${tasksPath}/${id}/rem`).set({ ...rem, ...upd });
    }
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const nagCfg = (await db.ref('todoNag').once('value')).val() || {};
      const owner = (await db.ref('todo/tasks').once('value')).val();
      await checkUser('staff-tasks', 'todo/tasks', owner, now, '', nagCfg);
      // משתמש נעול / שהתקופה שלו נגמרה - לא מקבל תזכורות
      const blocked = await require('./tasksAccess').blockedSet(db).catch(() => new Set());
      const users = (await db.ref('todo/users').once('value')).val() || {};
      for (const [uid, u] of Object.entries(users)) {
        if (SAFE.test(uid) && u && u.tasks && !blocked.has(uid)) await checkUser(uid, `todo/users/${uid}/tasks`, u.tasks, now, '', nagCfg);
      }
      const shared = (await db.ref('todo/shared').once('value')).val() || {};
      for (const [listId, l] of Object.entries(shared)) {
        if (!SAFE.test(listId) || !l || !l.tasks) continue;
        const members = Object.keys(l.members || {}).filter((m) => SAFE.test(m) && !blocked.has(m));
        if (members.length) await checkUser(members, `todo/shared/${listId}/tasks`, l.tasks, now, '[' + (l.name || 'משותף') + '] ', nagCfg);
      }
      health.lastOkAt = Date.now(); health.consecutiveErr = 0;
    } catch (err) {
      console.error('task reminders tick error:', err.message);
      health.consecutiveErr++; health.lastError = String(err.message || err).slice(0, 200);
    } finally {
      running = false;
      health.lastTickAt = Date.now();
    }
  }
  setInterval(tick, 60 * 1000);
  setTimeout(tick, 5000);
  console.log('⏰ תזכורות משימות פעילות');
}

module.exports = { register, ilTime, health };
