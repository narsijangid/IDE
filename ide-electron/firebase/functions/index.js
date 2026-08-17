'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { PLANS } = require('./lib/plans');
const { requestHash, paymentUrl, newTxnid } = require('./lib/payu');
const { getPayuCredentials, syncCredentialsToFirestore, publicCredsView } = require('./lib/credentials');
const { fulfillPayment, getSubscription, emailKey } = require('./lib/fulfill');

if (!admin.apps.length) {
  admin.initializeApp();
}

setGlobalOptions({
  region: 'asia-south1',
  maxInstances: 40,
  timeoutSeconds: 60,
  memory: '256MiB',
});

const SITE = () => String(process.env.SITE_URL || 'https://olkil.com').replace(/\/$/, '');

const app = express();
app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

let credsSynced = false;
async function ensureCredsSynced() {
  if (credsSynced) return;
  try {
    credsSynced = Boolean(await syncCredentialsToFirestore());
  } catch (err) {
    console.warn('cred sync', err.message);
  }
}

function internalOk(req) {
  const secret = String(process.env.INTERNAL_SECRET || '');
  if (!secret) return false;
  const hdr = String(req.get('x-olkil-internal') || req.get('x-olkil-signature') || '');
  const a = Buffer.from(hdr);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function optionalAuth(req) {
  const hdr = String(req.get('authorization') || '');
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

app.get('/v1/health', async (_req, res) => {
  try {
    await ensureCredsSynced();
    const creds = await getPayuCredentials();
    res.json({
      ok: true,
      service: 'olkil-payu',
      ...publicCredsView(creds),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get('/v1/plans', (_req, res) => {
  res.json({ plans: PLANS });
});

app.post('/v1/checkout', async (req, res) => {
  try {
    await ensureCredsSynced();
    const creds = await getPayuCredentials();
    const body = req.body || {};
    const planSlug = String(body.plan || '').toLowerCase();
    const plan = PLANS[planSlug];
    if (!plan) {
      return res.status(400).json({ error: 'invalid_plan' });
    }

    const firstname = String(body.firstname || '').trim();
    const email = emailKey(body.email);
    const phone = String(body.phone || '').replace(/\D+/g, '');
    if (firstname.length < 2 || !email.includes('@') || phone.length < 10) {
      return res.status(400).json({ error: 'invalid_customer' });
    }

    const decoded = await optionalAuth(req);
    const txnid = newTxnid();
    const site = SITE();
    const params = {
      key: creds.key,
      txnid,
      amount: plan.amount,
      productinfo: plan.name,
      firstname,
      email,
      phone,
      surl: `${site}/payment-success/`,
      furl: `${site}/payment-failed/`,
      notifyurl: `https://asia-south1-olkil-2c8ac.cloudfunctions.net/olkilPayuApi/v1/webhook`,
      udf1: plan.slug,
      udf2: decoded ? decoded.uid : '',
      udf3: creds.mode,
      udf4: '',
      udf5: '',
      service_provider: 'payu_paisa',
    };
    params.hash = requestHash(params, creds.salt);

    await admin.firestore().collection('orders').doc(txnid).set({
      txnid,
      plan: plan.slug,
      amount: plan.amount,
      email,
      firstname,
      phone,
      uid: decoded ? decoded.uid : '',
      status: 'pending',
      payuMode: creds.mode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      ok: true,
      mode: creds.mode,
      action: paymentUrl(creds.mode),
      params,
    });
  } catch (err) {
    console.error('checkout', err);
    res.status(500).json({ error: err.code || 'checkout_failed', message: err.message });
  }
});

async function handlePayuCallback(req, res, { redirect }) {
  try {
    await ensureCredsSynced();
    const creds = await getPayuCredentials();
    const data = Object.assign({}, req.body || {}, req.query || {});
    const result = await fulfillPayment({ creds, data, source: redirect ? 'browser' : 'webhook' });

    if (!redirect) {
      return res.status(200).json({ ok: Boolean(result.ok), paid: Boolean(result.paid), txnid: result.txnid || '' });
    }

    const site = SITE();
    const txnid = encodeURIComponent(String(data.txnid || ''));
    if (result.paid) {
      return res.redirect(303, `${site}/payment-success/?txnid=${txnid}`);
    }
    return res.redirect(303, `${site}/payment-failed/?txnid=${txnid}`);
  } catch (err) {
    console.error('payu callback', err);
    if (!redirect) return res.status(200).json({ ok: false });
    return res.redirect(303, `${SITE()}/payment-failed/`);
  }
}

app.post('/v1/webhook', (req, res) => handlePayuCallback(req, res, { redirect: false }));
app.get('/v1/webhook', (req, res) => handlePayuCallback(req, res, { redirect: false }));
app.post('/v1/return', (req, res) => handlePayuCallback(req, res, { redirect: true }));

app.post('/v1/fulfill', async (req, res) => {
  try {
    if (!internalOk(req)) return res.status(401).json({ error: 'unauthorized' });
    await ensureCredsSynced();
    const creds = await getPayuCredentials();
    const result = await fulfillPayment({ creds, data: req.body || {}, source: 'wordpress' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/v1/subscription', async (req, res) => {
  const decoded = await optionalAuth(req);
  const email = emailKey((decoded && decoded.email) || req.query.email);
  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!decoded && !internalOk(req)) {
    return res.status(401).json({ error: 'auth_required' });
  }
  const sub = await getSubscription(email);
  res.json(sub);
});

app.get('/v1/invoice', async (req, res) => {
  const txnid = String(req.query.txnid || '').trim();
  if (!txnid) return res.status(400).json({ error: 'txnid_required' });
  const decoded = await optionalAuth(req);
  const snap = await admin.firestore().collection('orders').doc(txnid).get();
  if (!snap.exists) return res.status(404).json({ error: 'not_found' });
  const order = snap.data();
  const email = emailKey((decoded && decoded.email) || req.query.email);
  if (!internalOk(req) && email !== emailKey(order.email)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (req.query.format === 'html') {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(order.invoiceHtml || '<p>Invoice not ready</p>');
  }
  res.json({
    txnid,
    status: order.status,
    invoice: order.invoice || null,
    receiptHtml: undefined,
  });
});

app.get('/v1/orders', async (req, res) => {
  const decoded = await optionalAuth(req);
  const email = emailKey((decoded && decoded.email) || req.query.email);
  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!decoded && !internalOk(req)) return res.status(401).json({ error: 'auth_required' });
  const qs = await admin
    .firestore()
    .collection('orders')
    .where('email', '==', email)
    .orderBy('createdAt', 'desc')
    .limit(25)
    .get();
  res.json({
    orders: qs.docs.map((d) => {
      const o = d.data();
      return {
        txnid: o.txnid,
        plan: o.plan,
        amount: o.amount,
        status: o.status,
        invoiceNo: o.invoice && o.invoice.invoiceNo,
        paidAt: o.paidAt || null,
      };
    }),
  });
});

exports.olkilPayuApi = onRequest(
  {
    cors: true,
    invoker: 'public',
    region: 'asia-south1',
  },
  app
);

module.exports.app = app;
