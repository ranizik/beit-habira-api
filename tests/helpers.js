// כלי עזר לבדיקות: Firebase מדומה (בזיכרון), Express מדומה, ו-FCM מדומה
const path = require('path');
const MODS = ['taskReminders', 'tasksGcal', 'tasksStats', 'tasksAccess', 'tasksHealth'];

function fakeDb(initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), store);
  const set = (p, v) => {
    const ks = parts(p); let o = store;
    ks.slice(0, -1).forEach((k) => { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
    if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v));
  };
  let pushN = 0;
  const ref = (p) => ({
    key: parts(p).slice(-1)[0],
    once: async () => ({ val: () => { const v = get(p); return v === undefined ? null : JSON.parse(JSON.stringify(v)); } }),
    set: async (v) => set(p, v),
    update: async (u) => { for (const [k, v] of Object.entries(u)) set(p + '/' + k, v); },
    remove: async () => set(p, null),
    child: (c) => ref(p + '/' + c),
    transaction: async (fn) => set(p, fn(get(p))),
    push: (v) => { const k = 'k' + String(++pushN).padStart(4, '0'); const r = ref(p + '/' + k); if (v !== undefined) { set(p + '/' + k, v); return Promise.resolve(r); } return r; },
  });
  return { store, ref, get };
}

function fakeAdmin(users) {
  const sent = [];
  const tokens = {};
  return {
    sent, tokens,
    auth: () => ({
      verifyIdToken: async (t) => { if (tokens[t]) return tokens[t]; throw new Error('bad token'); },
      getUser: async (uid) => ({ uid, metadata: { creationTime: new Date((users && users[uid] && users[uid].created) || 0).toUTCString() } }),
      getUsers: async (list) => ({ users: list.map(({ uid }) => ({ uid, email: (users && users[uid] && users[uid].email) || uid + '@x.com', displayName: (users && users[uid] && users[uid].name) || uid, metadata: { creationTime: new Date((users && users[uid] && users[uid].created) || 0).toUTCString() } })) }),
      getUserByEmail: async (e) => { const f = Object.entries(users || {}).find(([, u]) => u.email === e); if (!f) throw new Error('no user'); return { uid: f[0], email: e, displayName: f[1].name }; },
    }),
    messaging: () => ({
      sendEachForMulticast: async (m) => { sent.push({ title: m.notification.title, body: m.notification.body, data: m.data, tokens: m.tokens }); return { successCount: m.tokens.length, responses: m.tokens.map(() => ({})) }; },
    }),
  };
}

function fakeApp() {
  const routes = {};
  const app = { post: (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; }, get: (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; }, use: () => {} };
  const call = async (method, p, { token, body, headers } = {}) => {
    const h = routes[method + ' ' + p]; if (!h) throw new Error('no route ' + p);
    let out = { status: 200 };
    const res = { status(c) { out.status = c; return this; }, json(j) { out.body = j; return this; }, type() { return this; }, send(b) { out.body = b; return this; }, redirect(c, u) { out.status = c; out.location = u; } };
    await h({ headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body || {}, query: {}, ip: '1.1.1.1' }, res);
    return out;
  };
  return { app, routes, call };
}

// טוען את המודולים מחדש (בלי מטמון) ותופס את הטיימרים במקום להפעיל אותם
function load(names, db, admin) {
  MODS.forEach((m) => { delete require.cache[require.resolve(path.join('..', m))]; });
  const timers = [];
  const si = global.setInterval, st = global.setTimeout;
  global.setInterval = (f, ms) => { timers.push({ f, ms, kind: 'interval' }); return 0; };
  global.setTimeout = (f, ms) => { timers.push({ f, ms, kind: 'timeout' }); return 0; };
  const { app, routes, call } = fakeApp();
  const express = { json: () => null, urlencoded: () => null };
  const mods = {};
  try { for (const n of names) { mods[n] = require(path.join('..', n)); mods[n].register(app, admin, db, express); } }
  finally { global.setInterval = si; global.setTimeout = st; }
  return { mods, routes, call, timers };
}

// שעה מקומית בישראל לפני X דקות, בפורמט של משימה
function ilAgo(min) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(Date.now() - min * 60000)).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const ilHourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', hour: '2-digit' }).format(new Date()));

module.exports = { fakeDb, fakeAdmin, load, ilAgo, ilHourNow };
