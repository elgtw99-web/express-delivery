/**
 * 採購貨物追蹤儀表盤 — 後端服務
 * 功能：
 *   1. /api/query              即時查詢快遞100物流狀態（金鑰留後端）
 *   2. /api/orders (CRUD)       採購訂單儀表盤：新增(自動訂閱+查一次)、列表、更新、刪除
 *   3. /api/subscribe          單號訂閱（相容舊用法）
 *   4. /api/kd100/callback      快遞100推送回呼：更新訂單 + 有新狀態推 LINE 群組
 *   5. /api/line/webhook        LINE 群組機器人：打關鍵字主動查詢並回覆
 *   6. /                        提供前端 index.html
 *
 * 啟動：node server.js   （環境變數見 .env.example）
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
// 保留原始 body 供 LINE webhook 驗簽（圖片辨識需較大上限）
app.use(express.json({ limit: '12mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.static(__dirname));

// ---- 設定 ----
// .trim() 防止貼上時多帶空白/換行導致簽名錯誤
const KD_CUSTOMER = (process.env.KD100_CUSTOMER || '').trim();
const KD_KEY      = (process.env.KD100_KEY || '').trim();
const KD_SECRET   = (process.env.KD100_SECRET || process.env.KD100_KEY || '').trim();  // 訂閱授權key
const CALLBACK_URL= (process.env.CALLBACK_URL || '').trim();          // 對外 https + /api/kd100/callback
const SALT        = (process.env.KD100_SALT || 'kd100salt').trim();
const LINE_TOKEN  = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
const LINE_SECRET = (process.env.LINE_CHANNEL_SECRET || '').trim();   // webhook 驗簽用
const DEFAULT_LINE_TO = (process.env.LINE_DEFAULT_TO || '').trim();   // 群組ID 或 使用者ID
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();    // 截圖 AI 辨識用
const PORT        = process.env.PORT || 3000;

const md5upper = s => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase();

// ---- 資料儲存（存檔，重啟不遺失）----
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
let SUBS = {};
try { SUBS = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { SUBS = {}; }
const saveSubs = () => fs.writeFileSync(SUBS_FILE, JSON.stringify(SUBS, null, 2));

// ---- Firestore（訂單持久化 + 多人同步）----
const admin = require('firebase-admin');
let db = null;
let FB_STATUS = 'not-started';
// 依序嘗試：Render Secret File → 專案內檔 → 環境變數
function loadServiceAccount() {
  const files = ['/etc/secrets/firebase-key.json', path.join(__dirname, 'firebase-key.json')];
  for (const f of files) {
    if (fs.existsSync(f)) {
      try { const sa = JSON.parse(fs.readFileSync(f, 'utf8')); FB_STATUS = 'file-loaded:' + f; return sa; }
      catch (e) { FB_STATUS = 'file-parse-error(' + f + '): ' + e.message; return null; }
    }
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try { const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); FB_STATUS = 'env-loaded'; return sa; }
    catch (e) { FB_STATUS = 'env-parse-error: ' + e.message; return null; }
  }
  FB_STATUS = 'no-key-found';
  return null;
}
try {
  const sa = loadServiceAccount();
  if (sa) {
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n'); // 兼容被轉義的換行
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    db = admin.firestore();
    FB_STATUS = 'connected:' + sa.project_id;
    console.log('✅ Firestore 已連線，專案：', sa.project_id);
  } else {
    console.warn('⚠️ 未提供/無法讀取 Firebase 金鑰：', FB_STATUS);
  }
} catch (e) { FB_STATUS = 'init-error: ' + e.message; console.error('Firebase 初始化失敗：', e.message); }

const memOrders = {};   // 未接資料庫時的後備
async function ordersAll() {
  if (db) { const s = await db.collection('orders').get(); return s.docs.map(d => d.data()); }
  return Object.values(memOrders);
}
async function orderGet(id) {
  if (db) { const d = await db.collection('orders').doc(id).get(); return d.exists ? d.data() : null; }
  return memOrders[id] || null;
}
async function orderSet(o) {
  o.lastUpdate = Date.now();
  if (db) await db.collection('orders').doc(o.id).set(o, { merge: true });
  else memOrders[o.id] = o;
}
async function orderDelete(id) {
  if (db) await db.collection('orders').doc(id).delete();
  else delete memOrders[id];
}
async function orderFindByTrack(num) {
  if (db) { const s = await db.collection('orders').where('trackNo', '==', num).limit(1).get(); return s.empty ? null : s.docs[0].data(); }
  return Object.values(memOrders).find(o => o.trackNo === num) || null;
}

// 記錄最近一次 LINE 事件來源（方便取得群組ID）
let LAST_SOURCE = null;

const CARRIER_NAME = {
  shunfeng:'順豐速運', yuantong:'圓通速遞', zhongtong:'中通快遞', shentong:'申通快遞',
  yunda:'韻達速遞', jd:'京東物流', ems:'EMS/中國郵政', huitongkuaidi:'百世快遞'
};
const STATE_LABEL = {0:'運輸中',1:'已攬收',2:'疑難件',3:'已簽收',4:'退簽',5:'派件中',6:'退回'};

// 依單號前綴自動識別快遞公司
function autoDetectServer(no){
  no = String(no).toUpperCase();
  if (/^SF/.test(no)) return 'shunfeng';
  if (/^YT/.test(no)) return 'yuantong';
  if (/^(ZT|75|78)/.test(no)) return 'zhongtong';
  if (/^(ST|77|55|66)/.test(no)) return 'shentong';
  if (/^(YD|12|19|31|39|43)/.test(no)) return 'yunda';
  if (/^JD/.test(no)) return 'jd';
  if (/^(EMS|E[A-Z])/.test(no) || /^\d{13}$/.test(no)) return 'ems';
  if (/^(HT|A|B|K)/.test(no)) return 'huitongkuaidi';
  return 'shunfeng';
}

// 共用：即時查詢（phone = 收/寄件人手機號後四碼，順豐/中通等需要）
async function kd100Query(num, com, phone){
  if (!KD_CUSTOMER || !KD_KEY) throw new Error('後端未設定 KD100_CUSTOMER / KD100_KEY');
  const p = { com: com || 'auto', num };
  if (phone) p.phone = phone;
  const param = JSON.stringify(p);
  const sign = md5upper(param + KD_KEY + KD_CUSTOMER);
  const body = new URLSearchParams({ customer: KD_CUSTOMER, sign, param });
  const r = await fetch('https://poll.kuaidi100.com/poll/query.do', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (j.returnCode && j.returnCode !== '200') {
    console.error('快遞100查詢失敗 raw=', JSON.stringify(j), 'com=', com);
    throw new Error((j.message || '查詢失敗') + '（returnCode ' + j.returnCode + '，com=' + com + '）');
  }
  return {
    state: Number(j.state),
    stateLabel: STATE_LABEL[Number(j.state)] || '運輸中',
    list: (j.data || []).map(x => ({ time: x.ftime || x.time, text: x.context }))
  };
}

// 共用：訂閱推送
async function kd100Subscribe(num, com, phone){
  if (!CALLBACK_URL) throw new Error('後端未設定 CALLBACK_URL（快遞100推送回呼網址）');
  const param = {
    company: com, number: num, key: KD_SECRET,
    parameters: { callbackurl: CALLBACK_URL, salt: SALT, resultv2: '1', autoCom: '0', phone: phone || '' }
  };
  const body = new URLSearchParams({ schema: 'json', param: JSON.stringify(param) });
  const r = await fetch('https://poll.kuaidi100.com/poll', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!(j.result === true || j.returnCode === '200')) throw new Error(j.message || '訂閱失敗');
  return j;
}

// ============ 1. 即時查詢 ============
app.post('/api/query', async (req, res) => {
  try {
    const { num, com, phone } = req.body;
    if (!num) return res.status(400).json({ error: '缺少單號 num' });
    res.json(await kd100Query(num, com, phone));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 2. 採購訂單儀表盤 CRUD ============
app.get('/api/orders', async (req, res) => {
  try {
    const list = await ordersAll();
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { items, products, supplier, purchaseTime, orderNo, trackNo, carrier, lineTo, phone } = req.body;
    if (!trackNo) return res.status(400).json({ error: '缺少快遞號碼 trackNo' });
    const com = (carrier && carrier !== 'auto') ? carrier : autoDetectServer(trackNo);
    const id = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // 多產品：[{name, orderedQty}] → 標準化並補到貨欄位
    let prods = Array.isArray(products)
      ? products.map(p => ({ name: (p.name || '').trim(), orderedQty: Number(p.orderedQty) || 0, arrivedQty: Number(p.arrivedQty) || 0 })).filter(p => p.name)
      : [];
    if (!prods.length && items) prods = [{ name: String(items).trim(), orderedQty: 0, arrivedQty: 0 }]; // 相容舊單一品項
    const itemsSummary = prods.map(p => p.name + (p.orderedQty ? ' x' + p.orderedQty : '')).join('、');
    const order = {
      id, products: prods, items: itemsSummary, supplier: supplier || '', purchaseTime: purchaseTime || '',
      orderNo: orderNo || '', trackNo, carrier: com, carrierName: CARRIER_NAME[com] || com,
      phone: phone || '', lineTo: lineTo || DEFAULT_LINE_TO, state: null, stateLabel: '待更新',
      latest: '', timeline: [], notified: false, subscribed: false,
      arrived: false, arrivalDate: '', arrivalNote: '', createdAt: Date.now(), lastUpdate: null
    };
    let warn = '';
    try { await kd100Subscribe(trackNo, com, phone); order.subscribed = true; }
    catch (e) { warn = '訂閱未成功：' + e.message; }
    try {
      const q = await kd100Query(trackNo, com, phone);
      order.state = q.state; order.stateLabel = q.stateLabel;
      order.latest = q.list[0]?.text || ''; order.timeline = q.list; order.lastUpdate = Date.now();
    } catch (e) { /* 查不到先留待更新 */ }
    await orderSet(order);
    res.json({ ok: true, order, warn });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id/refresh', async (req, res) => {
  try {
    const o = await orderGet(req.params.id);
    if (!o) return res.status(404).json({ error: '找不到訂單' });
    const q = await kd100Query(o.trackNo, o.carrier, o.phone);
    o.state = q.state; o.stateLabel = q.stateLabel;
    o.latest = q.list[0]?.text || ''; o.timeline = q.list; o.lastUpdate = Date.now();
    await orderSet(o);
    res.json({ ok: true, order: o });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/orders/:id', async (req, res) => {
  try { await orderDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 登記到貨（進貨單）→ 逐產品更新到貨數量、對比訂購數 + LINE 通知業務
app.post('/api/orders/:id/arrival', async (req, res) => {
  try {
    const o = await orderGet(req.params.id);
    if (!o) return res.status(404).json({ error: '找不到訂單' });
    const { arrivals, arrivalNote } = req.body;   // arrivals: 依產品順序的到貨數量陣列
    if (!Array.isArray(o.products)) o.products = [];
    if (Array.isArray(arrivals)) {
      arrivals.forEach((q, i) => { if (o.products[i]) o.products[i].arrivedQty = Number(q) || 0; });
    }
    o.arrivalNote = arrivalNote || '';
    o.arrivalDate = new Date().toISOString().slice(0, 10);
    o.arrived = o.products.length > 0 && o.products.every(p => p.orderedQty > 0 && p.arrivedQty >= p.orderedQty);
    o.lastUpdate = Date.now();
    await orderSet(o);
    // LINE 通知（逐產品訂購 vs 到貨）
    const lines = o.products.map(p => {
      const short = (p.orderedQty || 0) - (p.arrivedQty || 0);
      return `・${p.name}：訂購 ${p.orderedQty} / 到貨 ${p.arrivedQty}` + (short > 0 ? `（短少 ${short}）` : short < 0 ? `（多 ${-short}）` : ' ✅');
    }).join('\n');
    const head = o.arrived ? '📥 到貨報備（已到齊）' : '📥 到貨報備（部分到貨）';
    const msg = `${head}\n訂單編號：${o.orderNo || '-'}\n供應商：${o.supplier || '-'}\n${lines}\n`
      + (o.arrivalNote ? `備註：${o.arrivalNote}\n` : '') + `請業務確認進貨。`;
    await pushLine(o.lineTo, msg);
    res.json({ ok: true, order: o });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量匯入（前端已解析 Excel + 簡轉繁）→ 建立多筆訂單
app.post('/api/orders/batch', async (req, res) => {
  try {
    const { orders, track } = req.body;
    if (!Array.isArray(orders) || !orders.length) return res.status(400).json({ error: '沒有可匯入的訂單' });
    let created = 0, skipped = 0; const errors = [];
    for (const it of orders) {
      try {
        if (!it.trackNo) { errors.push('缺運單號：' + (it.orderNo || '(無編號)')); continue; }
        if (await orderFindByTrack(String(it.trackNo))) { skipped++; continue; }   // 已存在則略過，避免重複
        const com = (it.carrier && it.carrier !== 'auto') ? it.carrier : autoDetectServer(it.trackNo);
        const id = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const prods = Array.isArray(it.products)
          ? it.products.map(p => ({ name: (p.name || '').trim(), orderedQty: Number(p.orderedQty) || 0, arrivedQty: 0, unitPrice: Number(p.unitPrice) || 0, unit: p.unit || '' })).filter(p => p.name)
          : [];
        const order = {
          id, products: prods, items: prods.map(p => p.name + (p.orderedQty ? ' x' + p.orderedQty : '')).join('、'),
          supplier: it.supplier || '', purchaseTime: it.purchaseTime || '', orderNo: it.orderNo || '',
          trackNo: String(it.trackNo).trim(), carrier: com, carrierName: CARRIER_NAME[com] || com, phone: it.phone || '',
          lineTo: DEFAULT_LINE_TO, state: null, stateLabel: '待更新', latest: '', timeline: [], notified: false, subscribed: false,
          arrived: false, arrivalDate: '', arrivalNote: it.note || '',
          region: '大陸', currency: 'RMB', goodsTotal: Number(it.goodsTotal) || 0, freight: Number(it.freight) || 0, actualPay: Number(it.actualPay) || 0,
          createdAt: Date.now(), lastUpdate: null, source: 'import'
        };
        if (track) {
          try { await kd100Subscribe(order.trackNo, com, order.phone); order.subscribed = true; } catch (e) {}
          try { const q = await kd100Query(order.trackNo, com, order.phone); order.state = q.state; order.stateLabel = q.stateLabel; order.latest = q.list[0]?.text || ''; order.timeline = q.list; order.lastUpdate = Date.now(); } catch (e) {}
        }
        await orderSet(order); created++;
      } catch (e) { errors.push(e.message); }
    }
    res.json({ ok: true, created, skipped, total: orders.length, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 3. 單號訂閱（相容舊用法）============
app.post('/api/subscribe', async (req, res) => {
  try {
    const { num, com, lineTo } = req.body;
    if (!num || !com) return res.status(400).json({ error: '需要單號 num 與快遞公司 com' });
    await kd100Subscribe(num, com);
    SUBS[num] = { com, lineTo: lineTo || DEFAULT_LINE_TO, ts: Date.now(), notified: false };
    saveSubs();
    res.json({ ok: true, message: '已訂閱，狀態更新時將以 LINE 通知' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 4. 快遞100 推送回呼 ============
app.post('/api/kd100/callback', async (req, res) => {
  try {
    const paramStr = req.body.param;
    const sign = req.body.sign;
    if (!paramStr) return res.json({ result: false, returnCode: '400', message: 'no param' });
    if (sign && md5upper(paramStr + SALT) !== String(sign).toUpperCase()) {
      return res.json({ result: false, returnCode: '400', message: 'sign error' });
    }
    const p = JSON.parse(paramStr);
    const num = p.lastResult?.nu || p.nu;
    const state = Number(p.lastResult?.state ?? p.state);
    const list = (p.lastResult?.data || []).map(x => ({ time: x.ftime || x.time, text: x.context }));
    const latest = list[0]?.text || '';

    // (1) 更新儀表盤訂單，並在「有新狀態」時推到群組
    const order = await orderFindByTrack(num);
    if (order) {
      const isNew = latest && latest !== order.latest;
      order.state = state; order.stateLabel = STATE_LABEL[state] || '運輸中';
      order.latest = latest; order.timeline = list; order.lastUpdate = Date.now();
      if (isNew) {
        const signed = state === 3;
        const head = signed ? '✅ 已簽收' : '🚚 物流更新';
        const msg = `${head}\n品項：${order.items || '-'}\n供應商：${order.supplier || '-'}\n`
          + `訂單編號：${order.orderNo || '-'}\n${order.carrierName} ${num}\n最新：${latest}`;
        await pushLine(order.lineTo, msg);
        if (signed) order.notified = true;
      }
      await orderSet(order);
    }

    // (2) 相容舊的單號訂閱
    const sub = SUBS[num];
    if (sub && state === 3 && !sub.notified) {
      const co = CARRIER_NAME[sub.com] || sub.com;
      await pushLine(sub.lineTo, `✅ 快件已簽收！\n${co} ${num}\n最新狀態：${latest}`);
      sub.notified = true; saveSubs();
    }

    res.json({ result: true, returnCode: '200', message: '成功' });
  } catch (e) {
    console.error(e);
    res.json({ result: false, returnCode: '500', message: e.message });
  }
});

// ---- LINE Messaging API ----
async function pushLine(to, text){
  const target = to || DEFAULT_LINE_TO;
  if (!LINE_TOKEN || !target) { console.warn('LINE 未設定，略過通知'); return; }
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify({ to: target, messages: [{ type: 'text', text }] })
  });
  if (!r.ok) console.error('LINE push 失敗', r.status, await r.text());
}
async function replyLine(replyToken, text){
  if (!LINE_TOKEN) return;
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!r.ok) console.error('LINE reply 失敗', r.status, await r.text());
}

// 依關鍵字找訂單（訂單編號 / 快遞號 / 品項 / 供應商）
async function findOrderByKeyword(kw){
  const q = kw.replace(/^(查詢?|物流|狀態|進度|status)\s*/i, '').trim();
  if (!q) return null;
  const all = await ordersAll();
  return all.find(o => o.orderNo === q || o.trackNo === q)
      || all.find(o => (o.orderNo && o.orderNo.includes(q)) || (o.trackNo && o.trackNo.includes(q)))
      || all.find(o => (o.items && o.items.includes(q)) || (o.supplier && o.supplier.includes(q)))
      || null;
}
function formatOrderReply(o, q){
  const latest = q?.list?.[0];
  return `📦 ${o.items || '(未填品項)'}\n供應商：${o.supplier || '-'}\n`
    + `訂單編號：${o.orderNo || '-'}\n${o.carrierName} ${o.trackNo}\n`
    + `目前狀態：${q?.stateLabel || o.stateLabel}\n`
    + (latest ? `最新：${latest.text}\n時間：${latest.time}` : '');
}

// ---- LINE Webhook：群組內打關鍵字主動查詢 ----
app.post('/api/line/webhook', async (req, res) => {
  try {
    if (LINE_SECRET) {
      const sig = crypto.createHmac('sha256', LINE_SECRET).update(req.rawBody || Buffer.from('')).digest('base64');
      if (sig !== req.headers['x-line-signature']) return res.status(401).end();
    }
    res.status(200).end();  // 先回 200，避免 LINE 逾時重送
    const events = req.body.events || [];
    for (const ev of events) {
      if (ev.source) LAST_SOURCE = { type: ev.source.type, groupId: ev.source.groupId || '', roomId: ev.source.roomId || '', userId: ev.source.userId || '', at: new Date().toISOString() };
      if (ev.type !== 'message' || ev.message?.type !== 'text') continue;
      const text = ev.message.text.trim();
      let reply;
      const order = await findOrderByKeyword(text);
      if (order) {
        let q = null;
        try { q = await kd100Query(order.trackNo, order.carrier, order.phone); } catch (e) {}
        reply = formatOrderReply(order, q);
      } else if (/^[A-Za-z0-9]{6,}$/.test(text)) {
        try {
          const q = await kd100Query(text, autoDetectServer(text));
          reply = `📦 ${text}\n目前狀態：${q.stateLabel}\n最新：${q.list[0]?.text || '查無軌跡'}`;
        } catch (e) { reply = `查不到「${text}」的物流資料`; }
      } else {
        reply = '請輸入「訂單編號 / 快遞單號 / 品項 / 供應商」即可查詢目前物流狀態。\n例：查 SF1234567890';
      }
      await replyLine(ev.replyToken, reply);
    }
  } catch (e) { console.error('webhook 錯誤', e); }
});

// 取得最近一次 LINE 事件來源（把機器人加入群組、群組發一則訊息後打開此網址即可看到 groupId）
app.get('/api/line/lastsource', (req, res) => {
  res.json(LAST_SOURCE || { note: '尚未收到任何 LINE 事件。請先設定 Webhook、把機器人加入群組，並在群組發一則訊息，再重新整理此頁。' });
});

// 測試 LINE 是否可通
app.post('/api/line/test', async (req, res) => {
  try { await pushLine(req.body.lineTo, '✅ LINE 通知測試成功：採購貨物追蹤儀表盤已就緒'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 5. 截圖 AI 辨識（自動帶出訂單號/快遞號/手機末四碼）============
const OCR_PROMPT = `你是物流截圖資訊擷取助手。從這張快遞/訂單截圖擷取以下欄位，只輸出 JSON、不要多餘文字：
{"orderNo":"訂單編號","trackNo":"快遞單號","phone4":"收件人或寄件人手機號的後四碼","carrier":"快遞公司代碼"}
規則：
- carrier 只能是：shunfeng(順豐) / yuantong(圓通) / zhongtong(中通) / shentong(申通) / yunda(韻達) / jd(京東) / ems(郵政EMS) / huitongkuaidi(百世)，判斷不出留空。
- phone4：只取「收件人 / 寄件人」手機號的後四碼（通常在「收貨地址」「收件人」姓名旁）。務必跳過物流明細裡「快遞員【姓名：號碼】」的電話、以及客服/網點電話（如 020-…）。若看不到收件人手機，留空字串。
- 找不到的欄位一律回空字串 ""。`;

app.post('/api/ocr', async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: '後端未設定 OPENAI_API_KEY（AI 辨識金鑰）' });
    const { image } = req.body;   // data URL: data:image/png;base64,....
    if (!image) return res.status(400).json({ error: '缺少圖片' });
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: image } }
          ]
        }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(500).json({ error: j.error?.message || 'AI 辨識失敗' });
    let txt = (j.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim();
    let data;
    try { data = JSON.parse(txt); } catch (e) { return res.status(500).json({ error: '辨識結果解析失敗', raw: txt }); }
    res.json({ ok: true, orderNo: data.orderNo || '', trackNo: data.trackNo || '', phone4: data.phone4 || '', carrier: data.carrier || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config', async (req, res) => {
  let orderCount = 0;
  try { orderCount = (await ordersAll()).length; } catch (e) {}
  res.json({
    hasKd100: !!(KD_CUSTOMER && KD_KEY),
    hasOcr: !!OPENAI_API_KEY,
    hasDb: !!db,
    hasLine: !!LINE_TOKEN,
    hasCallback: !!CALLBACK_URL,
    hasWebhook: !!LINE_SECRET,
    hasGroup: !!DEFAULT_LINE_TO,
    orderCount,
    subCount: Object.keys(SUBS).length
  });
});

// 安全診斷：只回長度與是否含空白，不外洩實際金鑰
app.get('/api/diag', (req, res) => {
  const rawC = process.env.KD100_CUSTOMER || '';
  const rawK = process.env.KD100_KEY || '';
  const rawS = process.env.KD100_SECRET || '';
  res.json({
    customerLen: rawC.length, customerHadWhitespace: rawC !== rawC.trim(), customerHasInnerSpace: /\s/.test(rawC.trim()),
    keyLen: rawK.length, keyHadWhitespace: rawK !== rawK.trim(), keyHasInnerSpace: /\s/.test(rawK.trim()),
    secretLen: rawS.length,
    callbackUrl: CALLBACK_URL,
    fbStatus: FB_STATUS,
    secretFileExists: fs.existsSync('/etc/secrets/firebase-key.json')
  });
});

app.listen(PORT, () => console.log(`✅ 採購貨物追蹤儀表盤啟動： http://localhost:${PORT}`));
