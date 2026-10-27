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

function register(app, admin, db, express) {
  async function authUser(req) {
    const h = req.headers.authorization || '';
    const decoded = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
    return decoded && SAFE.test(decoded.uid) ? decoded : null;
  }
  const displayName = (d) => String(d.uid === 'staff-tasks' ? 'רני' : (d.name || (d.email || '').split('@')[0] || 'משתמש')).slice(0, 40);
  const randomCode = () => require('crypto').randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);

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
      await db.ref(`todo/shared/${listId}/members/${d.uid}`).set({ name: displayName(d), at: Date.now() });
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
      const others = Object.keys(list.members).filter((u) => u !== d.uid && SAFE.test(u));
      let sent = 0;
      for (const u of others) sent += await sendToUser(u, '👥 ' + (list.name || 'רשימה משותפת'), who + ' הוסיף/ה: ' + name, 'list-' + listId);
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
      await db.ref(`todo/shared/${listId}/members/${d.uid}`).remove();
      await db.ref(`todo/userLists/${d.uid}/${listId}`).remove();
      // הרשימה עצמה לא נמחקת לעולם (גם כשכולם יצאו) - כדי שלא יאבדו משימות בטעות
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /tasks/lists/leave error:', err.message);
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

  async function sendToUser(uid, title, body, taskId) {
    const snap = await db.ref(`todoPushTokens/${uid}`).once('value');
    const entries = Object.entries(snap.val() || {}).filter(([, v]) => v && v.token);
    if (!entries.length) return 0;
    const result = await admin.messaging().sendEachForMulticast({
      tokens: entries.map(([, v]) => v.token),
      notification: { title, body },
      data: { type: 'task-reminder', taskId: String(taskId), link: '/tasks/' },
      webpush: { fcmOptions: { link: 'https://beit-habira.com/tasks/' }, headers: { Urgency: 'high', TTL: '21600' } },
    });
    const cleanup = {};
    result.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') cleanup[entries[i][0]] = null;
    });
    if (Object.keys(cleanup).length) await db.ref(`todoPushTokens/${uid}`).update(cleanup);
    return result.successCount;
  }
  module.exports.sendToUser = sendToUser; // גם למודול המנויים (tasksAccess)

  // uids = מי מקבל את התזכורת (משתמש אחד ברשימה פרטית, כל החברים ברשימה משותפת)
  async function checkUser(uids, tasksPath, tasks, now, prefix) {
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
      if (t.time && !rem.at && now >= taskAt && now - taskAt < MAX_LATE_MS) {
        upd.at = true;
        await send('⏰ הגיע הזמן: ' + (prefix || '') + t.name, 'עכשיו - ' + t.time, id);
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
      const owner = (await db.ref('todo/tasks').once('value')).val();
      await checkUser('staff-tasks', 'todo/tasks', owner, now);
      // משתמש נעול / שהתקופה שלו נגמרה - לא מקבל תזכורות
      const blocked = await require('./tasksAccess').blockedSet(db).catch(() => new Set());
      const users = (await db.ref('todo/users').once('value')).val() || {};
      for (const [uid, u] of Object.entries(users)) {
        if (SAFE.test(uid) && u && u.tasks && !blocked.has(uid)) await checkUser(uid, `todo/users/${uid}/tasks`, u.tasks, now);
      }
      const shared = (await db.ref('todo/shared').once('value')).val() || {};
      for (const [listId, l] of Object.entries(shared)) {
        if (!SAFE.test(listId) || !l || !l.tasks) continue;
        const members = Object.keys(l.members || {}).filter((m) => SAFE.test(m) && !blocked.has(m));
        if (members.length) await checkUser(members, `todo/shared/${listId}/tasks`, l.tasks, now, '[' + (l.name || 'משותף') + '] ');
      }
    } catch (err) {
      console.error('task reminders tick error:', err.message);
    } finally {
      running = false;
    }
  }
  setInterval(tick, 60 * 1000);
  setTimeout(tick, 5000);
  console.log('⏰ תזכורות משימות פעילות');
}

module.exports = { register, ilTime };
