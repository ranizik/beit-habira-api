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
  app.post('/tasks/push-register', express.json(), async (req, res) => {
    try {
      const h = req.headers.authorization || '';
      const decoded = h.startsWith('Bearer ') ? await admin.auth().verifyIdToken(h.slice(7)).catch(() => null) : null;
      if (!decoded || !SAFE.test(decoded.uid)) return res.status(401).json({ error: 'אין הרשאה' });
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

  async function checkUser(uid, tasksPath, tasks, now) {
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
        await sendToUser(uid, '📋 תזכורת למחר: ' + t.name, 'מחר' + (t.time ? ' בשעה ' + t.time : ''), id);
      }
      if (t.time && !rem.at && now >= taskAt && now - taskAt < MAX_LATE_MS) {
        upd.at = true;
        await sendToUser(uid, '⏰ הגיע הזמן: ' + t.name, 'עכשיו - ' + t.time, id);
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
      const users = (await db.ref('todo/users').once('value')).val() || {};
      for (const [uid, u] of Object.entries(users)) {
        if (SAFE.test(uid) && u && u.tasks) await checkUser(uid, `todo/users/${uid}/tasks`, u.tasks, now);
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
