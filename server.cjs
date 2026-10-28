const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const fakeIndexedDb = require('fake-indexeddb');

const HOST = process.env.LYNKBAY_HOST || '0.0.0.0';
const PORT = Number(process.env.LYNKBAY_PORT || process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DEFAULT_DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || DATA_DIR;
const DATA_FILE = process.env.LYNKBAY_DATA_FILE || path.join(DEFAULT_DATA_DIR, 'lynkbay-db.json');
const SECRET_FILE = path.join(DEFAULT_DATA_DIR, 'lynkbay-api-secret.txt');
const DB_SCRIPT = path.join(ROOT_DIR, 'js', 'db.js');
const ALLOWED_ORIGINS = String(process.env.LYNKBAY_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function resolveApiSecret() {
  if (process.env.LYNKBAY_API_SECRET && process.env.LYNKBAY_API_SECRET.trim()) {
    return process.env.LYNKBAY_API_SECRET.trim();
  }
  if (process.env.API_SECRET && process.env.API_SECRET.trim()) {
    return process.env.API_SECRET.trim();
  }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (stored) return stored;
    }
  } catch (err) {}

  const generated = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, generated, 'utf8');
  } catch (err) {}
  return generated;
}

const API_SECRET = resolveApiSecret();

const ALLOWED_METHODS = new Set([
  'addProduct',
  'addInventoryLog',
  'getInventoryLogs',
  'updateProduct',
  'deleteProduct',
  'restoreProduct',
  'deductStock',
  'addBackStock',
  'cancelBillAndReturnStock',
  'saveBillWithStockAndCollectionLog',
  'collectBillPaymentAtomic',
  'updateBillWithStockAndCollectionLog',
  'getProducts',
  'getCustomers',
  'updateCustomer',
  'renameCustomerInBills',
  'addCustomer',
  'deleteCustomer',
  'upsertCustomerByName',
  'syncCustomersFromBills',
  'deleteBillAndReturnStock',
  'updateBill',
  'deleteBill',
  'getBillById',
  'getBills',
  'addCollectionLog',
  'getCollectionLogs',
  'getCollectionLogsByBill',
  'addExpense',
  'getExpenses',
  'updateExpense',
  'deleteExpense',
  'addAuditLog',
  'getAuditLogs',
  'saveSetting',
  'getSetting',
  'getNextBillNumber',
  'recalculateBillCounter',
  'saveImportRollback',
  'getImportRollback',
  'getImportRollbacks',
  'clearImportRollback',
  'exportAllData',
  'importAllData'
]);

const READ_ONLY_PREFIXES = ['get', 'export'];
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

let db;
let queue = Promise.resolve();

function createDatabase() {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    fetch: undefined,
    location: undefined,
    window: null,
    indexedDB: fakeIndexedDb.indexedDB,
    IDBKeyRange: fakeIndexedDb.IDBKeyRange
  };
  context.window = context;
  Object.assign(context, fakeIndexedDb);

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(DB_SCRIPT, 'utf8'), context, { filename: DB_SCRIPT });
  return new context.Database();
}

async function initDatabase() {
  db = createDatabase();
  await db.init();

  if (fs.existsSync(DATA_FILE)) {
    const payload = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    await db.importAllData(payload);
  } else {
    await persistDatabase();
  }
}

async function persistDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = await db.exportAllData();
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function isReadOnly(method) {
  return READ_ONLY_PREFIXES.some((prefix) => method.startsWith(prefix));
}

function runExclusive(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function sendJson(req, res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(payload));
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(req) {
  const origin = req?.headers?.origin;
  if (!isAllowedOrigin(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-LynkBay-Secret, X-API-Key, Authorization',
    'Vary': 'Origin'
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON request.'));
      }
    });
    req.on('error', reject);
  });
}

function getProvidedAuthSecret(req, payload) {
  const headerKey = req.headers['x-lynkbay-secret'] || req.headers['x-api-key'];
  if (headerKey) return String(headerKey).trim();

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  if (payload && payload.authSecret) {
    return String(payload.authSecret).trim();
  }

  return '';
}

async function handleApi(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...corsHeaders(req),
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-LynkBay-Secret, X-API-Key, Authorization'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/db/call') {
    sendJson(req, res, 404, { ok: false, error: 'API route not found.' });
    return;
  }

  try {
    const payload = await readJsonBody(req);
    const providedSecret = getProvidedAuthSecret(req, payload);

    if (!API_SECRET || providedSecret !== API_SECRET) {
      sendJson(req, res, 401, { ok: false, error: 'Unauthorized: Invalid or missing API secret.' });
      return;
    }

    const method = String(payload.method || '');
    const args = Array.isArray(payload.args) ? payload.args : [];

    if (!ALLOWED_METHODS.has(method) || typeof db[method] !== 'function') {
      sendJson(req, res, 400, { ok: false, error: `Unsupported database method: ${method}` });
      return;
    }

    const result = await runExclusive(async () => {
      const value = await db[method](...args);
      if (!isReadOnly(method)) {
        await persistDatabase();
      }
      return value;
    });

    sendJson(req, res, 200, { ok: true, result });
  } catch (err) {
    sendJson(req, res, 500, { ok: false, error: err.message || 'Server error.' });
  }
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  if (pathname === '/js/deploy-config.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(`window.LYNKBAY_API_BASE_URL = window.LYNKBAY_API_BASE_URL || '';\nwindow.LYNKBAY_API_SECRET = ${JSON.stringify(API_SECRET)};\n`);
    return;
  }

  const filePath = path.normalize(path.join(ROOT_DIR, pathname));
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.js' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(content);
  });
}

initDatabase()
  .then(() => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        handleApi(req, res);
        return;
      }
      serveStatic(req, res);
    });

    server.listen(PORT, HOST, () => {
      console.log(`LynkBay server running at http://localhost:${PORT}`);
      console.log(`Shared data file: ${DATA_FILE}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
