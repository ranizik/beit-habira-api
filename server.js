/**
 * Beit HaBira - Integration API
 * ׳©׳›׳‘׳× ׳—׳™׳‘׳•׳¨ ׳‘׳™׳ ׳׳₪׳׳™׳§׳¦׳™׳™׳× ׳”׳”׳–׳׳ ׳•׳× (Firebase) ׳׳‘׳™׳ ׳׳ ׳•׳¢ ׳”׳§׳•׳₪׳•׳×
 *
 * Environment Variables ׳ ׳“׳¨׳©׳™׳:
 *   FIREBASE_KEY     - ׳×׳•׳›׳ ׳§׳•׳‘׳¥ ׳”-Service Account JSON (׳›׳׳—׳¨׳•׳–׳× ׳׳—׳×)
 *   FIREBASE_DB_URL  - ׳›׳×׳•׳‘׳× ׳”-Realtime Database
 *   API_KEY          - ׳׳₪׳×׳— ׳¡׳•׳“׳™ ׳׳׳™׳׳•׳× ׳‘׳§׳©׳•׳× ׳-API ׳”׳–׳”
 *
 * ׳¡׳ ׳™׳₪׳™׳ ׳×׳§׳₪׳™׳: shfayim | tel_mond
 */

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const ExcelJS = require('exceljs');

// ---------- ׳‘׳“׳™׳§׳× ׳׳©׳×׳ ׳™ ׳¡׳‘׳™׳‘׳” ----------
const REQUIRED_ENV = ['FIREBASE_KEY', 'FIREBASE_DB_URL', 'API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('ג ׳—׳¡׳¨׳™׳ ׳׳©׳×׳ ׳™ ׳¡׳‘׳™׳‘׳”:', missing.join(', '));
  process.exit(1);
}

const VALID_BRANCHES = ['shfayim', 'tel_mond'];

// ---------- ׳׳×׳—׳•׳ Firebase ----------
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (err) {
  console.error('ג FIREBASE_KEY ׳׳™׳ ׳• JSON ׳×׳§׳™׳:', err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL,
});

const db = admin.database();

// ---------- Express App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ׳׳•׳’׳™׳ ׳‘׳¡׳™׳¡׳™׳™׳ ׳׳›׳ ׳‘׳§׳©׳”
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// ׳”׳’׳ ׳× Rate Limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. ׳ ׳¡׳” ׳©׳•׳‘ ׳‘׳¢׳•׳“ ׳¨׳’׳¢.' },
});
app.use(limiter);

// ׳׳™׳׳•׳× API Key - ׳׳×׳§׳‘׳ ׳’׳ ׳›-header ׳•׳’׳ ׳›׳₪׳¨׳׳˜׳¨ ׳‘׳›׳×׳•׳‘׳× (?api_key=...) ׳׳¦׳•׳¨׳ ׳×׳׳™׳׳•׳×
// ׳¢׳ ׳׳¢׳¨׳›׳•׳× ׳©׳׳ ׳×׳•׳׳›׳•׳× ׳‘׳©׳׳™׳—׳× headers ׳׳•׳×׳׳׳™׳ (׳›׳׳• ׳§׳™׳©׳•׳¨ ׳™׳©׳™׳¨ ׳׳”׳•׳¨׳“׳× ׳§׳•׳‘׳¥).
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - API key ׳—׳¡׳¨ ׳׳• ׳©׳’׳•׳™' });
  }
  next();
}

// ---------- Health Check (׳׳׳ ׳׳™׳׳•׳×) ----------
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'beit-habira-api', time: new Date().toISOString() });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------- Middleware ׳׳™׳׳•׳× ׳׳›׳ ׳©׳׳¨ ׳”׳ ׳×׳™׳‘׳™׳ ----------
app.use(requireApiKey);

// ---------- ׳¢׳–׳¨: ׳§׳¨׳™׳׳× ׳¢׳ ׳£ ׳-Firebase ׳¢׳ timeout ----------
function readRef(path, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firebase timeout')), timeoutMs);
    db.ref(path)
      .once('value')
      .then((snap) => {
        clearTimeout(timer);
        resolve(snap.val());
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function validateBranch(branch, res) {
  if (!branch) {
    res.status(400).json({ error: `׳₪׳¨׳׳˜׳¨ branch ׳—׳•׳‘׳” (${VALID_BRANCHES.join(' / ')})` });
    return false;
  }
  if (!VALID_BRANCHES.includes(branch)) {
    res.status(400).json({ error: `branch ׳׳ ׳×׳§׳™׳. ׳¢׳¨׳›׳™׳ ׳×׳§׳₪׳™׳: ${VALID_BRANCHES.join(' / ')}` });
    return false;
  }
  return true;
}

// ---------- ׳¢׳–׳¨׳™ ׳ ׳•׳¨׳׳׳™׳–׳¦׳™׳” - Firebase ׳׳₪׳¢׳׳™׳ ׳©׳•׳׳¨ ׳׳¢׳¨׳›׳™׳ ׳›׳׳•׳‘׳™׳™׳§׳˜ ׳¢׳ ׳׳₪׳×׳—׳•׳× ׳׳¡׳₪׳¨׳™׳™׳ ----------
function normArr(a) {
  if (Array.isArray(a)) return a;
  if (!a) return [];
  return Object.keys(a).sort((x, y) => +x - +y).map((k) => a[k]);
}
function skKey(name) {
  return String(name).replace(/[.#$[\]/]/g, '_');
}
function isPromoActive(promo) {
  if (!promo || !promo.type) return false;
  const now = new Date();
  if (promo.from && new Date(promo.from) > now) return false;
  if (promo.to && new Date(promo.to) < now) return false;
  return true;
}

// ---------- ׳׳™׳‘׳”: ׳©׳׳™׳₪׳× ׳›׳ ׳”׳׳•׳¦׳¨׳™׳ ׳©׳ ׳¡׳ ׳™׳£, ׳‘׳₪׳•׳¨׳׳˜ ׳׳—׳™׳“ ----------
async function fetchProducts(branch) {
  const data = await readRef(`suppliers/${branch}`);
  const suppliers = normArr(data);
  const products = [];

  suppliers.forEach((sup) => {
    if (!sup) return;
    const cats = normArr(sup.cats);
    cats.forEach((cat) => {
      if (!cat) return;
      const items = normArr(cat.items);
      items.forEach((name) => {
        if (!name) return;
        const isk = skKey(name);
        const priceEntry = (cat.prices || {})[isk] ?? (cat.prices || {})[name];
        const price = priceEntry ? (typeof priceEntry === 'object' ? priceEntry.b || 0 : parseFloat(priceEntry) || 0) : 0;
        const unitsPerBox = priceEntry && typeof priceEntry === 'object' ? priceEntry.unitsPerBox || 0 : 0;
        const barcode = (cat.barcodes || {})[isk] ?? (cat.barcodes || {})[name] ?? '';
        const promoRaw = (cat.promos || {})[isk] ?? (cat.promos || {})[name] ?? null;
        const promoActive = isPromoActive(promoRaw);
        products.push({
          barcode: barcode || null,
          name,
          category: cat.cat || null,
          supplier: sup.label || sup.key || '',
          unitPrice: price,
          unitsPerBox: unitsPerBox || null,
          promoActive,
          promoType: promoActive ? promoRaw.type : null,
          promoValue: promoActive ? promoRaw.val : null,
        });
      });
    });
  });

  return products;
}

// ---------- ׳׳™׳‘׳”: ׳©׳׳™׳₪׳× ׳”׳–׳׳ ׳•׳× (׳׳”׳™׳¡׳˜׳•׳¨׳™׳™׳× ׳”׳”׳–׳׳ ׳•׳×) ----------
async function fetchOrders(branch, { from, to } = {}) {
  const historyData = await readRef(`orderHistory/${branch}`);
  if (!historyData) return [];

  const records = Object.entries(historyData).map(([id, rec]) => ({ id, ...rec }));

  let filtered = records;
  if (from) filtered = filtered.filter((r) => r.date && new Date(r.date).getTime() >= Number(from));
  if (to) filtered = filtered.filter((r) => r.date && new Date(r.date).getTime() <= Number(to));

  return filtered;
}

function ordersToManeoRows(orderRecords, barcodeMap) {
  const rows = [];
  orderRecords.forEach((rec) => {
    (rec.items || []).forEach((item) => {
      const barcode = barcodeMap ? barcodeMap.get(`${item.cat}||${item.name}`) : null;
      rows.push({
        orderId: rec.id,
        date: rec.date || null,
        supplier: rec.supLabel || '',
        barcode: barcode || '',
        name: item.name || '',
        quantity: item.lineUnits ?? ((item.cartons || 0) + (item.units || 0)) ?? 0,
        unitPrice: item.price ?? 0,
        discount: item.promo ? item.promo.val || 0 : 0,
      });
    });
  });
  return rows;
}

// ================= JSON API =================

// GET /products?branch=shfayim
app.get('/products', async (req, res) => {
  try {
    const { branch } = req.query;
    if (!validateBranch(branch, res)) return;
    const products = await fetchProducts(branch);
    res.json({ branch, count: products.length, products });
  } catch (err) {
    console.error('GET /products error:', err.message);
    res.status(502).json({ error: '׳©׳’׳™׳׳” ׳‘׳§׳¨׳™׳׳× ׳׳•׳¦׳¨׳™׳', details: err.message });
  }
});

// GET /orders?branch=shfayim&format=maneo&from=...&to=...
app.get('/orders', async (req, res) => {
  try {
    const { branch, format, from, to } = req.query;
    if (!validateBranch(branch, res)) return;

    const [orderRecords, products] = await Promise.all([
      fetchOrders(branch, { from, to }),
      fetchProducts(branch),
    ]);
    const barcodeMap = new Map();
    products.forEach((p) => barcodeMap.set(`${p.category}||${p.name}`, p.barcode));

    if (format === 'maneo') {
      const rows = ordersToManeoRows(orderRecords, barcodeMap);
      return res.json({ branch, format: 'maneo', count: rows.length, rows });
    }

    res.json({ branch, count: orderRecords.length, orders: orderRecords });
  } catch (err) {
    console.error('GET /orders error:', err.message);
    res.status(502).json({ error: '׳©׳’׳™׳׳” ׳‘׳§׳¨׳™׳׳× ׳”׳–׳׳ ׳•׳×', details: err.message });
  }
});

// ================= ׳§׳‘׳¦׳™ Excel (׳׳™׳ ׳§ ׳¡׳˜׳˜׳™ ׳׳”׳•׳¨׳“׳” - ׳׳׳¢׳¨׳›׳•׳× ׳©׳׳ ׳×׳•׳׳›׳•׳× ׳‘-API ׳¨׳’׳™׳) =================

// GET /files/products.xlsx?branch=shfayim&api_key=...
app.get('/files/products.xlsx', async (req, res) => {
  try {
    const { branch } = req.query;
    if (!validateBranch(branch, res)) return;
    const products = await fetchProducts(branch);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('׳׳•׳¦׳¨׳™׳');
    ws.views = [{ rightToLeft: true }];
    ws.columns = [
      { header: '׳‘׳¨׳§׳•׳“', key: 'barcode', width: 16 },
      { header: '׳©׳ ׳׳•׳¦׳¨', key: 'name', width: 35 },
      { header: '׳§׳˜׳’׳•׳¨׳™׳”', key: 'category', width: 18 },
      { header: '׳¡׳₪׳§', key: 'supplier', width: 20 },
      { header: '׳׳—׳™׳¨ ׳™׳—׳™׳“׳”', key: 'unitPrice', width: 12 },
      { header: '׳™׳—\' ׳‘׳§׳¨׳˜׳•׳', key: 'unitsPerBox', width: 12 },
      { header: '׳׳‘׳¦׳¢ ׳₪׳¢׳™׳', key: 'promoActive', width: 10 },
      { header: '׳¡׳•׳’ ׳׳‘׳¦׳¢', key: 'promoType', width: 10 },
      { header: '׳¢׳¨׳ ׳׳‘׳¦׳¢', key: 'promoValue', width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    products.forEach((p) => ws.addRow(p));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="products-${branch}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('GET /files/products.xlsx error:', err.message);
    res.status(502).json({ error: '׳©׳’׳™׳׳” ׳‘׳™׳¦׳™׳¨׳× ׳§׳•׳‘׳¥ Excel', details: err.message });
  }
});

// GET /files/orders.xlsx?branch=shfayim&api_key=...
app.get('/files/orders.xlsx', async (req, res) => {
  try {
    const { branch, from, to } = req.query;
    if (!validateBranch(branch, res)) return;

    const [orderRecords, products] = await Promise.all([
      fetchOrders(branch, { from, to }),
      fetchProducts(branch),
    ]);
    const barcodeMap = new Map();
    products.forEach((p) => barcodeMap.set(`${p.category}||${p.name}`, p.barcode));
    const rows = ordersToManeoRows(orderRecords, barcodeMap);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('׳”׳–׳׳ ׳•׳×');
    ws.views = [{ rightToLeft: true }];
    ws.columns = [
      { header: '׳׳–׳”׳” ׳”׳–׳׳ ׳”', key: 'orderId', width: 22 },
      { header: '׳×׳׳¨׳™׳', key: 'date', width: 20 },
      { header: '׳¡׳₪׳§', key: 'supplier', width: 20 },
      { header: '׳‘׳¨׳§׳•׳“', key: 'barcode', width: 16 },
      { header: '׳©׳ ׳׳•׳¦׳¨', key: 'name', width: 35 },
      { header: '׳›׳׳•׳×', key: 'quantity', width: 10 },
      { header: '׳׳—׳™׳¨ ׳™׳—׳™׳“׳”', key: 'unitPrice', width: 12 },
      { header: '׳”׳ ׳—׳”', key: 'discount', width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${branch}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('GET /files/orders.xlsx error:', err.message);
    res.status(502).json({ error: '׳©׳’׳™׳׳” ׳‘׳™׳¦׳™׳¨׳× ׳§׳•׳‘׳¥ Excel', details: err.message });
  }
});

// ================= ׳˜׳™׳₪׳•׳ ׳‘׳©׳’׳™׳׳•׳× ׳›׳׳׳™׳•׳× =================

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint ׳׳ ׳ ׳׳¦׳' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: '׳©׳’׳™׳׳× ׳©׳¨׳× ׳₪׳ ׳™׳׳™׳×' });
});

// ---------- ׳”׳₪׳¢׳׳× ׳”׳©׳¨׳× ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ג… Beit HaBira API ׳¨׳¥ ׳¢׳ ׳₪׳•׳¨׳˜ ${PORT}`);
});
