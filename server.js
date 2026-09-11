app.post('/notify-new-order', express.json(), async (req, res) => {
  try {
    const { branch, orderId } = req.body || {};
    if (!branch || !orderId || !VALID_BRANCHES.includes(branch)) {
      return res.status(400).json({ error: 'branch ו-orderId תקפים חובה' });
    }
    // מוודאים שההזמנה אכן קיימת (לא סתם שולחים התראות שרירותיות)
    const orderSnap = await db.ref(`pickupOrders/${branch}/${orderId}`).once('value');
    const order = orderSnap.val();
    if (!order) return res.status(404).json({ error: 'הזמנה לא נמצאה' });

    const tokensSnap = await db.ref(`adminPushTokens/${branch}`).once('value');
    const tokensData = tokensSnap.val() || {};
    const entries = Object.entries(tokensData).filter(([k, t]) => t && t.token);
    const tokens = entries.map(([k, t]) => t.token);

    if (!tokens.length) {
      return res.json({ ok: true, sent: 0, note: 'אין מכשירי admin רשומים להתראות בסניף הזה' });
    }

    const message = {
      notification: {
        title: 'הזמנה חדשה 🔔',
        body: `${order.customerName || 'לקוח'} · ₪${(order.totalAmount || 0).toFixed(2)} · ${(order.items || []).length} פריטים`,
      },
      data: { orderId: String(orderId), branch: String(branch), type: 'new-order' },
      tokens,
    };
    const result = await admin.messaging().sendEachForMulticast(message);

    // מנקים מזהי מכשיר שכבר לא תקפים
    const invalidKeys = [];
    result.responses.forEach((r, i) => {
      if (!r.success && r.error && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(r.error.code)) {
        invalidKeys.push(entries[i][0]);
      }
    });
    if (invalidKeys.length) {
      const cleanup = {};
      invalidKeys.forEach((k) => { cleanup[k] = null; });
      await db.ref(`adminPushTokens/${branch}`).update(cleanup);
    }

    // חוזרים מיד - עדכון profile יהיה ברקע
    res.json({ ok: true, sent: result.successCount, failed: result.failureCount });

    // עדכון כרטיס לקוח ברקע (לא מחכים עליו)
    (async () => {
      try {
        const phoneKey = skKey(order.customerPhone || '');
        if (phoneKey) {
          const retailSnap = await db.ref(`retail/${branch}`).once('value');
          const retailData = retailSnap.val() || {};
          const updates = {
            name: order.customerName || '',
            phone: order.customerPhone || '',
            lastOrderAt: Date.now(),
            totalOrders: admin.database.ServerValue.increment(1),
            totalSpent: admin.database.ServerValue.increment(order.totalAmount || 0),
          };
          (order.items || []).forEach((item) => {
            const product = retailData[item.barcode];
            const category = product && product.category;
            if (category) updates[`categoryCounts/${skKey(category)}`] = admin.database.ServerValue.increment(item.qty || 1);
          });
          await db.ref(`customerProfiles/${branch}/${phoneKey}`).update(updates);
        }
      } catch (profileErr) {
        console.error('עדכון כרטיס לקוח נכשל:', profileErr.message);
      }
    })();

  } catch (err) {
    console.error('POST /notify-new-order error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
});
