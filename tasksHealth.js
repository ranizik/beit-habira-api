/**
 * בדיקה עצמית של שרת המשימות (תכל׳ס) - התראה לבעל העסק כשמשהו נשבר, לפני שהמשתמשים מרגישים
 *   GET /tasks/health  -> { ok, tickAgeSec, consecutiveErr, sendOk, sendFail }  (ציבורי, בלי מידע אישי; מתאים ל-UptimeRobot)
 * כל 5 דקות נבדק:
 *   - לולאת התזכורות לא רצה יותר מ-5 דקות (תקועה)
 *   - 3 שגיאות רצופות בלולאת התזכורות
 *   - הרבה התראות שנכשלו בשליחה (FCM)
 * בעיה -> התראת Push לבעל העסק ("⚠️ תכל׳ס: ..."), לכל היותר פעם בשעה לכל סוג. חזרה לתקינות -> "✅ חזר לעבוד".
 */
const OWNER = 'staff-tasks';
const CHECK_MS = 5 * 60 * 1000;
const REPEAT_MS = 60 * 60 * 1000;

function register(app, admin, db, express) {
  const rem = () => require('./taskReminders');
  const state = { alerts: {}, prevSend: { ok: 0, fail: 0 } };

  const status = () => {
    const h = rem().health || {};
    const now = Date.now();
    const tickAgeSec = h.lastTickAt ? Math.round((now - h.lastTickAt) / 1000) : Math.round((now - (h.startedAt || now)) / 1000);
    return { tickAgeSec, consecutiveErr: h.consecutiveErr || 0, lastError: h.lastError || '', sendOk: h.sendOk || 0, sendFail: h.sendFail || 0 };
  };

  app.get('/tasks/health', (req, res) => {
    const s = status();
    const ok = s.tickAgeSec < 300 && s.consecutiveErr < 3;
    res.status(ok ? 200 : 503).json({ ok, tickAgeSec: s.tickAgeSec, consecutiveErr: s.consecutiveErr, sendOk: s.sendOk, sendFail: s.sendFail });
  });

  async function alert(kind, problem, msg) {
    const now = Date.now();
    const a = state.alerts[kind] || { active: false, at: 0 };
    const send = (t, b) => { const fn = rem().sendToUser; return fn ? fn(OWNER, t, b, 'health').catch(() => 0) : 0; };
    if (problem) {
      console.warn('⚠️ health:', kind, msg);
      if (!a.active || now - a.at > REPEAT_MS) { await send('⚠️ תכל׳ס: ' + msg, 'בדיקה עצמית של השרת. אם זה נמשך – לבדוק ב-Render (Logs).'); a.at = now; }
      a.active = true;
    } else if (a.active) {
      await send('✅ תכל׳ס חזר לעבוד', 'התקלה (' + kind + ') נפתרה');
      a.active = false;
    }
    state.alerts[kind] = a;
  }

  async function check() {
    try {
      const s = status();
      await alert('tick', s.tickAgeSec > 300, 'התזכורות לא רצות כבר ' + Math.round(s.tickAgeSec / 60) + ' דקות');
      await alert('errors', s.consecutiveErr >= 3, 'שגיאות חוזרות בתזכורות: ' + s.lastError);
      const dOk = s.sendOk - state.prevSend.ok, dFail = s.sendFail - state.prevSend.fail;
      state.prevSend = { ok: s.sendOk, fail: s.sendFail };
      await alert('push', dFail >= 5 && dFail > dOk, 'התראות לא נשלחות (' + dFail + ' נכשלו ב-5 הדקות האחרונות)');
      // רישום בבסיס הנתונים - לצפייה ב-📊 ולמתכנת
      await db.ref('todoHealth').set({ at: Date.now(), ...s, alerts: Object.fromEntries(Object.entries(state.alerts).map(([k, v]) => [k, !!v.active])) }).catch(() => {});
    } catch (err) {
      console.error('health check error:', err.message);
    }
  }
  setInterval(check, CHECK_MS);
  setTimeout(check, 3 * 60 * 1000);
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message ? e.message : e));
  console.log('🩺 בדיקה עצמית של המשימות פעילה');
}

module.exports = { register };
