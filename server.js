const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const REQUIRED_ENV = ['FIREBASE_KEY', 'FIREBASE_DB_URL', 'API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ חסרים:', missing.join(', '));
  process.exit(1);
}

const VALID_BRANCHES = ['shfayim', 'tel_mond'];
const db = admin.database();

function skKey(name) {
  return String(name).replace(/[.#$[\]/]/g, '_');
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: process.env.FIREBASE_DB_URL,
});

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/create-order', express.json(), async (req, res) => {
  try {
    const { branch, items, pickupDay, pickupSlot, customerName, customerPhone, marketingConsent } = req.body || {};
    if (!branch || !VALID_BRANCHES.includes(branch)) return res.status(400).json({ error: 'branch לא תקף' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items חובה' });
    if (!pickupSlot) return res.status(400).json({ error: 'pickupSlot חובה' });

    const retailSnap = await db.ref(`retail/${branch}`).once('value');
    const retailData = retailSnap.val() || {};

    let totalAmount = 0;
    for (const item of items) {
      const prod = retailData[item.barcode];
      if (!prod) return res.status(409).json({ error: 'מוצר לא נמצא', unavailableBarcode: item.barcode });
      totalAmount += (prod.price || 0) * (item.qty || 1);
    }

    const order = {
      branch, items, pickupDay, pickupSlot,
      customerName: String(customerName).trim(),
      customerPhone: String(customerPhone).replace(/\D/g, ''),
      totalAmount, status: 'new', createdAt: Date.now(),
      marketingConsent: !!marketingConsent,
    };

    const ref = await db.ref(`pickupOrders/${branch}`).push(order);
    res.json({ ok: true, orderId: ref.key, order });
  } catch (err) {
    console.error('create-order error:', err.message);
    res.status(500).json({ error: 'יצירת הזמנה נכשלה' });
  }
});

app.post('/notify-new-order', express.json(), async (req, res) => {
  try {
    const { branch, orderId } = req.body || {};
    if (!branch || !orderId) return res.status(400).json({ error: 'branch ו-orderId חובה' });

    const orderSnap = await db.ref(`pickupOrders/${branch}/${orderId}`).once('value');
    const order = orderSnap.val();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    const tokensSnap = await db.ref(`adminPushTokens/${branch}`).once('value');
    const tokensData = tokensSnap.val() || {};
    const entries = Object.entries(tokensData).filter(([k, t]) => t && t.token);
    const tokens = entries.map(([k, t]) => t.token);

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0 });
    }

    const result = await admin.messaging().sendEachForMulticast({
      notification: {
        title: 'הזמנה חדשה 🔔',
        body: `${order.customerName
