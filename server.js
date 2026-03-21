// Pool Authority - Stripe Payment Server + Pool360 Auto-Import + Email + AI Tech Assist
// This server handles secure Stripe payment processing, Pool360 invoice imports, email sending, and AI diagnostics

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const OpenAI = require('openai').default || require('openai');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const app = express();

// Your Stripe Secret Key (use environment variable in production!)
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) {
  console.warn('WARNING: STRIPE_SECRET_KEY not set. Payment features will be disabled.');
}

// Supabase client with service role key (for auto-import writes)
const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) {
  console.warn('WARNING: SUPABASE_URL not set. Supabase features will be disabled.');
}
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

// ============================================================
// CORS — restrict to your actual domain(s) in production
// ============================================================
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8100', 'https://pool-authority.vercel.app'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  credentials: true,
}));

// ============================================================
// Webhook route MUST be before express.json() to get raw body
// ============================================================
app.post('/api/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json({ limit: '10mb' }));

// ============================================================
// HTML escaping utility — prevents XSS in emails and templates
// ============================================================
const escapeHtml = (str) => {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// ============================================================
// Authentication Middleware
// ============================================================
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.replace('Bearer ', '');
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// Optional auth — sets req.user if token present but doesn't block
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && supabase) {
    try {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) req.user = user;
    } catch (e) { /* continue without auth */ }
  }
  next();
};

// Simple rate limiter (in-memory, per-IP)
const rateLimitStore = new Map();
const rateLimit = (maxRequests, windowMs) => (req, res, next) => {
  const key = req.ip + ':' + req.path;
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    rateLimitStore.set(key, { windowStart: now, count: 1 });
    return next();
  }
  if (entry.count >= maxRequests) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  entry.count++;
  return next();
};
// Clean up rate limit store every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > 300000) rateLimitStore.delete(key);
  }
}, 300000);

// Store for payment sessions (in production, use a real database)
const paymentSessions = new Map();
// Clean up old payment sessions every hour (prevent memory leak)
setInterval(() => {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, session] of paymentSessions) {
    if (new Date(session.createdAt).getTime() < oneDayAgo) {
      paymentSessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

// ============================================================
// Email Setup (Resend HTTP API)
// ============================================================

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Pool Authority <onboarding@resend.dev>';

// Process email template: replace {{variable}} placeholders and handle {{#if var}}...{{/if}} blocks
const processTemplate = (template, data) => {
  if (!template) return '';
  let result = template;
  // Handle {{#if var}}...{{/if}} blocks
  result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, varName, content) => {
    return data[varName] ? content : '';
  });
  // Replace {{variable}} placeholders — use replaceAll to avoid ReDoS from regex-special keys
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(`{{${key}}}`, escapeHtml(value) || '');
  }
  return result;
};

// Convert markdown-style text to HTML for email
const textToHtml = (text) => {
  if (!text) return '';
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color:#1e3a5f;text-decoration:underline;">$1</a>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
    .replace(/• /g, '&bull; ');
};

// Build photo HTML for embedding in emails
const buildPhotosHtml = (photoUrls) => {
  if (!photoUrls || !Array.isArray(photoUrls) || photoUrls.length === 0) return '';
  const images = photoUrls
    .filter(url => typeof url === 'string' && /^https?:\/\//.test(url))
    .map(url =>
      `<img src="${escapeHtml(url)}" alt="Service photo" style="width:100%;max-width:560px;height:auto;border-radius:8px;display:block;" />`
    ).join('<div style="height:12px;"></div>');
  if (!images) return '';
  return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #eee;">
    <h3 style="margin:0 0 12px 0;color:#1e3a5f;font-size:16px;">Service Photos</h3>
    ${images}
  </div>`;
};

// Build a styled HTML email wrapper
const buildEmailHtml = (bodyContent, companySettings) => {
  const companyName = escapeHtml(companySettings?.companyName || 'Pool Authority');
  const companyPhone = escapeHtml(companySettings?.phone || '');
  const companyEmail = escapeHtml(companySettings?.email || EMAIL_FROM);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:20px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
  <div style="background:#1e3a5f;padding:20px 24px;text-align:center;">
    <h1 style="color:#ffffff;margin:0;font-size:22px;">${companyName}</h1>
  </div>
  <div style="padding:24px;color:#333;line-height:1.6;font-size:15px;">
    ${bodyContent}
  </div>
  <div style="background:#f8f9fa;padding:16px 24px;text-align:center;color:#888;font-size:12px;border-top:1px solid #eee;">
    ${companyName}${companyPhone ? ' | ' + companyPhone : ''}${companyEmail ? ' | ' + companyEmail : ''}
  </div>
</div>
</body></html>`;
};

// Send email via Resend HTTP API
const sendEmail = async (to, subject, htmlBody, fromName, attachments) => {
  if (!RESEND_API_KEY) {
    throw new Error('Email not configured. Set RESEND_API_KEY environment variable on Render.');
  }
  const emailMatch = EMAIL_FROM.match(/<([^>]+)>/);
  const fromAddress = emailMatch ? emailMatch[1] : EMAIL_FROM;
  const from = fromName ? `${fromName} <${fromAddress}>` : EMAIL_FROM;
  const payload = { from, to: [to], subject, html: htmlBody };
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.message || JSON.stringify(result));
  }
  return result;
};

// ============================================================
// Pool360 Auto-Import Helpers
// ============================================================

const categorizePool360Item = (description) => {
  const desc = (' ' + description.toLowerCase() + ' ');
  // Wear items first — replacement parts (check before equipment since 'filter' overlaps)
  const wearKeywords = [
    'plug','gasket','o-ring','oring','basket','valve','lid','cover','guard',
    'adapter','fitting','impeller','diverter','skimmer','drain plug',
    'flap','weir','eyeball','return fitting',
    'cartridge','lateral','standpipe','clamp','union','coupling','elbow',
    'cleaner bag','sweep','tire','wheel','diaphragm','spring',
    'bearing','pressure gauge','air relief','motor','capacitor','diffuser',
    'strainer','spider gasket','faceplate','multiport','shaft seal',
    'pump lid','pump basket','filter lid','check valve',
    'salt cell','light gasket','lens gasket','grid set','grid element',
    'drain cap','end cap','hose section',
  ];
  if (wearKeywords.some(k => desc.includes(k))) return 'wear_item';
  // Equipment — capital items
  const equipmentKeywords = [
    'pump','filter','heater','heat pump','cleaner','automation','controller',
    'blower','light','led','generator','feeder','robot','slide','ladder','rail',
    'diving','board',
  ];
  if (equipmentKeywords.some(k => desc.includes(k))) return 'equipment';
  // Default to chemical — pool supply orders are mostly chemicals/consumables
  return 'chemical';
};

const detectPool360Unit = (description, unitOfMeasure) => {
  const desc = description.toUpperCase();
  const multiLbMatch = desc.match(/(\d+)\s*X\s*(\d+\.?\d*)\s*(?:LB|#)/);
  if (multiLbMatch) return { unit: 'lbs', conversionFactor: parseInt(multiLbMatch[1]) * parseFloat(multiLbMatch[2]) };
  const weightMatch = desc.match(/(\d+)\s*(?:LB|#)/);
  if (weightMatch) return { unit: 'lbs', conversionFactor: parseInt(weightMatch[1]) };
  const multiGalMatch = desc.match(/(\d+)\s*X\s*(\d+\.?\d*)\s*GAL/);
  if (multiGalMatch) return { unit: 'gal', conversionFactor: parseInt(multiGalMatch[1]) * parseFloat(multiGalMatch[2]) };
  // Slash-separated gallons: "6/1GAL", "4/1GAL", "2/2.5GAL"
  const slashGal = desc.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*GAL/i);
  if (slashGal) return { unit: 'gal', conversionFactor: parseInt(slashGal[1]) * parseFloat(slashGal[2]) };
  const galMatch = desc.match(/(\d+\.?\d*)\s*GAL/);
  if (galMatch) return { unit: 'gal', conversionFactor: parseFloat(galMatch[1]) };
  const multiQtMatch = desc.match(/(\d+)\s*X\s*(\d+)\s*QT/);
  if (multiQtMatch) return { unit: 'oz', conversionFactor: parseInt(multiQtMatch[1]) * parseInt(multiQtMatch[2]) * 32 };
  const qtMatch = desc.match(/(\d+)\s*QT/);
  if (qtMatch) return { unit: 'oz', conversionFactor: parseInt(qtMatch[1]) * 32 };
  const ozMatch = desc.match(/(\d+\.?\d*)\s*OZ/);
  if (ozMatch) return { unit: 'oz', conversionFactor: parseFloat(ozMatch[1]) };
  if (unitOfMeasure === 'GL') return { unit: 'gal', conversionFactor: 1 };
  if (unitOfMeasure === 'BG' || unitOfMeasure === 'BK' || unitOfMeasure === 'PL') return { unit: 'lbs', conversionFactor: 1 };
  if (unitOfMeasure === 'DZ') return { unit: 'each', conversionFactor: 12 };
  // For cases/boxes/packs, try to detect pack count from description
  if (unitOfMeasure === 'CS' || unitOfMeasure === 'BX' || unitOfMeasure === 'PK') {
    // Detect gallon cases first (e.g., antifreeze "6/1GAL", or "4 GAL" cases)
    const csSlashGal = desc.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*GAL/i);
    if (csSlashGal) return { unit: 'gal', conversionFactor: parseInt(csSlashGal[1]) * parseFloat(csSlashGal[2]) };
    if (/GAL/i.test(desc)) {
      const csGalMatch = desc.match(/(\d+(?:\.\d+)?)\s*GAL/i);
      const csPackMatch = desc.match(/(\d+)\s*(?:PK|PACK|COUNT|CT|PCS?|\/\s*CS|\/\s*CASE)\b/);
      const galPerUnit = csGalMatch ? parseFloat(csGalMatch[1]) : 1;
      const packCount = csPackMatch ? parseInt(csPackMatch[1]) : 1;
      return { unit: 'gal', conversionFactor: packCount * galPerUnit };
    }
    const packMatch = desc.match(/(\d+)\s*(?:PK|PACK|COUNT|CT|PCS?)\b/);
    if (packMatch) return { unit: 'each', conversionFactor: parseInt(packMatch[1]) };
    const perMatch = desc.match(/(\d+)\s*(?:\/|PER)\s*(?:CS|CASE|BX|BOX)\b/);
    if (perMatch) return { unit: 'each', conversionFactor: parseInt(perMatch[1]) };
    const cntMatch = desc.match(/(\d+)\s*X\s*(\d+)(?:\s|$)/);
    if (cntMatch) return { unit: 'each', conversionFactor: parseInt(cntMatch[1]) * parseInt(cntMatch[2]) };
    return { unit: 'each', conversionFactor: 1 };
  }
  return { unit: 'each', conversionFactor: 1 };
};

// Use product code middle number as category signal
// Pool360 codes: PREFIX-MIDDLE-ITEM (e.g., PPG-50-1375)
// Middle 50 = chemicals, 06/25 = parts, 10/20/45 = equipment
const categorizeByProductCode = (productCode) => {
  const middleMatch = productCode.match(/[A-Z]+-(\d+)-/);
  if (!middleMatch) return null;
  const mid = parseInt(middleMatch[1]);
  if (mid === 50) return 'chemical';
  if ([6, 25].includes(mid)) return 'wear_item';
  if ([10, 20, 35, 45].includes(mid)) return 'equipment';
  return null;
};

const buildPool360Item = (productCode, catalogInfo, description, uomMatch, savedMapping) => {
  const fullText = (catalogInfo + ' ' + description).trim();
  const codeType = categorizeByProductCode(productCode);
  const autoType = savedMapping?.itemType || codeType || categorizePool360Item(fullText);
  const autoUnit = detectPool360Unit(fullText, uomMatch[1]);
  return {
    lineNum: parseInt(uomMatch.lineNum || 0),
    productCode,
    description: description || catalogInfo || `Product ${productCode}`,
    catalogInfo: catalogInfo || '',
    unitOfMeasure: uomMatch[1],
    openQty: parseInt(uomMatch[2]),
    orderedQty: parseInt(uomMatch[3]),
    shippedQty: parseInt(uomMatch[4]),
    backOrder: parseInt(uomMatch[5]),
    unitPrice: parseFloat(uomMatch[6]),
    totalPrice: parseFloat(uomMatch[7]),
    itemName: savedMapping?.itemName || description || catalogInfo || `Product ${productCode}`,
    itemType: autoType,
    usageUnit: savedMapping?.usageUnit || (autoType === 'chemical' ? autoUnit.unit : 'each'),
    conversionFactor: savedMapping?.conversionFactor || (autoType === 'chemical' ? autoUnit.conversionFactor : 1),
    category: savedMapping?.category || '',
  };
};

const parsePdfBuffer = async (buffer) => {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const allRows = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // Collect text items with positions, skip empties
    const textItems = content.items
      .filter(item => item.str.trim())
      .map(item => ({ str: item.str, x: item.transform[4], y: item.transform[5] }));

    // Sort by Y descending (top of page first)
    textItems.sort((a, b) => b.y - a.y);

    // Group into rows with 3-point Y tolerance (fixes items split across Y-coords)
    let groupItems = [];
    let groupY = null;
    for (const item of textItems) {
      if (groupY !== null && Math.abs(item.y - groupY) > 3) {
        const text = groupItems.sort((a, b) => a.x - b.x).map(it => it.str).join(' ').trim();
        if (text) allRows.push(text);
        groupItems = [];
        groupY = null;
      }
      groupItems.push(item);
      if (groupY === null) groupY = item.y;
    }
    if (groupItems.length > 0) {
      const text = groupItems.sort((a, b) => a.x - b.x).map(it => it.str).join(' ').trim();
      if (text) allRows.push(text);
    }
  }

  return { allRows };
};

const parsePool360Rows = (allRows, savedMappings) => {
  const items = [];
  // Flexible product code: line# then PREFIX-DIGITS-DIGITS
  const productRe = /(\d+)\s+([A-Z][A-Z0-9]*-\d+-\d+)/;
  // Expanded UOM codes
  const uomCodes = 'EA|CS|BX|BG|PL|BK|GL|DZ|CT|RL|PR|ST|PK|JR|DR|TB|BT|CN|PC|SF|LF|HD|KT';
  // Primary: UOM + open + ordered + shipped + backorder + unitPrice + totalPrice
  const uomRe = new RegExp(`(${uomCodes})\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)`);
  // Fallback: UOM + ordered + shipped + unitPrice + totalPrice (open/backorder omitted)
  const uomFallback = new RegExp(`(${uomCodes})\\s+(\\d+)\\s+(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)`);

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const productMatch = row.match(productRe);
    if (!productMatch) continue;

    // Try UOM on same row first
    let uomMatch = row.match(uomRe);
    let uomRow = row;
    let skipNext = false;

    // If not found, try combining with next row (PDF may split across Y-coords)
    if (!uomMatch && i + 1 < allRows.length) {
      const combined = row + ' ' + allRows[i + 1];
      uomMatch = combined.match(uomRe);
      if (uomMatch) { uomRow = combined; skipNext = true; }
    }

    // Fallback: fewer quantity columns
    if (!uomMatch) {
      const fb = row.match(uomFallback);
      if (fb) {
        uomMatch = [fb[0], fb[1], '0', fb[2], fb[3], '0', fb[4], fb[5]];
        uomRow = row;
      }
    }
    if (!uomMatch && i + 1 < allRows.length) {
      const combined = row + ' ' + allRows[i + 1];
      const fb = combined.match(uomFallback);
      if (fb) {
        uomMatch = [fb[0], fb[1], '0', fb[2], fb[3], '0', fb[4], fb[5]];
        uomRow = combined; skipNext = true;
      }
    }

    if (!uomMatch) continue;

    // Extract catalog info: text between product code and UOM code
    const codeEnd = uomRow.indexOf(productMatch[2]) + productMatch[2].length;
    const uomStart = uomRow.indexOf(uomMatch[1], codeEnd);
    const catalogInfo = (uomStart > codeEnd) ? uomRow.substring(codeEnd, uomStart).trim() : '';

    // Description from subsequent row(s)
    let description = '';
    const descStart = skipNext ? i + 2 : i + 1;
    for (let j = descStart; j < Math.min(descStart + 3, allRows.length); j++) {
      const descRow = allRows[j].trim();
      if (!descRow || descRow.match(productRe)) break;
      description = descRow.replace(/\s+[A-Z]-\d{2}-[A-Z]\s*$/, '').trim();
      if (description) break;
    }

    const savedMapping = savedMappings?.[productMatch[2]];
    uomMatch.lineNum = productMatch[1];
    items.push(buildPool360Item(productMatch[2], catalogInfo, description, uomMatch, savedMapping));
    if (skipNext) i++;
  }
  return items;
};

// POST /api/process-pool360 — Auto-import endpoint
app.post('/api/process-pool360', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Supabase not configured on server' });
    }

    const apiKey = req.headers['x-api-key'];
    const { orgId, pdfBase64 } = req.body;

    if (!apiKey || !orgId || !pdfBase64) {
      return res.status(400).json({ error: 'Missing required fields: orgId, pdfBase64, X-API-Key header' });
    }

    // Validate API key against org settings
    const { data: org, error: orgError } = await supabase
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .single();

    if (orgError || !org) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const storedKey = org.settings?.pool360ImportKey;
    if (!storedKey || !apiKey || storedKey.length !== apiKey.length ||
        !crypto.timingSafeEqual(Buffer.from(storedKey), Buffer.from(apiKey))) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Parse the PDF
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const { allRows } = await parsePdfBuffer(pdfBuffer);

    // Load saved mappings and import history
    const savedMappings = org.settings?.pool360Mappings || {};
    const importHistory = org.settings?.pool360ImportHistory || [];

    // Parse rows with catalog info extraction and product code categorization
    const parsedItems = parsePool360Rows(allRows, savedMappings);

    if (parsedItems.length === 0) {
      console.log(`Pool360: extracted ${allRows.length} text rows but found 0 line items`);
      if (allRows.length > 0) console.log('Pool360 first 5 rows:', allRows.slice(0, 5));
      return res.json({ success: true, message: `No line items found in PDF (${allRows.length} text rows extracted)`, imported: { chemicals: 0, wearItems: 0 }, debugRowCount: allRows.length });
    }

    // Date gate: only auto-import orders from 2026 onwards
    // Look for date patterns in the raw text rows (e.g., "01/15/2026", "2026-01-15", "Jan 15, 2026")
    let orderYear = null;
    for (const row of allRows.slice(0, 20)) {
      const mdyMatch = row.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})/);
      if (mdyMatch) { orderYear = parseInt(mdyMatch[3]); break; }
      const isoMatch = row.match(/(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (isoMatch) { orderYear = parseInt(isoMatch[1]); break; }
      const textMatch = row.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+(20\d{2})/i);
      if (textMatch) { orderYear = parseInt(textMatch[1]); break; }
    }
    if (orderYear && orderYear < 2026) {
      return res.json({ success: true, skipped: true, message: `Order is from ${orderYear} — only 2026+ orders are auto-imported. Use manual import for older receipts.`, imported: { chemicals: 0, wearItems: 0 } });
    }

    // Dedup check: hash the order and compare against import history
    const orderStr = parsedItems.map(i => `${i.productCode}:${i.shippedQty}`).sort().join('|');
    const hashKey = 'p360_' + crypto.createHash('sha256').update(orderStr).digest('hex').slice(0, 12);
    const existingImport = importHistory.find(h => h.hash === hashKey);
    if (existingImport) {
      return res.json({ success: true, skipped: true, message: `Already imported on ${existingImport.date} (${existingImport.itemCount} items)`, imported: { chemicals: 0, wearItems: 0 } });
    }

    // Categorize and import
    let chemCount = 0, wearCount = 0;

    // Fetch existing inventory (default to [] to prevent null pointer)
    const { data: existingChemicals_ } = await supabase
      .from('chemical_inventory')
      .select('*')
      .eq('org_id', orgId);
    const existingChemicals = existingChemicals_ || [];

    const { data: existingWearItems_ } = await supabase
      .from('wear_items')
      .select('*')
      .eq('org_id', orgId);
    const existingWearItems = existingWearItems_ || [];

    for (const item of parsedItems) {
      const itemType = item.itemType;
      const itemName = item.itemName;
      const conversionFactor = item.conversionFactor;

      if (itemType === 'chemical') {
        const actualQty = item.shippedQty * conversionFactor;
        const costPerUnit = conversionFactor > 1 ? item.unitPrice / conversionFactor : item.unitPrice;
        const usageUnit = item.usageUnit;

        const existing = (existingChemicals || []).find(c =>
          c.name.toLowerCase() === itemName.toLowerCase()
        );

        if (existing) {
          existing.quantity = (existing.quantity || 0) + actualQty;
          await supabase.from('chemical_inventory').update({
            quantity: existing.quantity,
            cost_per_unit: costPerUnit,
          }).eq('id', existing.id);
        } else {
          const { data: inserted } = await supabase.from('chemical_inventory').insert({
            org_id: orgId,
            name: itemName,
            category: item.category || '',
            quantity: actualQty,
            unit: usageUnit,
            cost_per_unit: costPerUnit,
            supplier: 'Pool360/SCP',
          }).select().single();
          // Track newly inserted item so same-named items later in this loop don't duplicate
          if (inserted) existingChemicals.push(inserted);
        }
        chemCount++;
      } else {
        const existingWear = (existingWearItems || []).find(w =>
          w.name.toLowerCase() === itemName.toLowerCase()
        );
        if (existingWear) {
          // Update existing wear item with latest price
          await supabase.from('wear_items').update({
            price: item.unitPrice,
            description: `Pool360: ${item.productCode} | Qty: ${item.shippedQty}`,
          }).eq('id', existingWear.id);
        } else {
          const { data: insertedWear } = await supabase.from('wear_items').insert({
            org_id: orgId,
            name: itemName,
            price: item.unitPrice,
            description: `Pool360: ${item.productCode} | Qty: ${item.shippedQty}`,
          }).select().single();
          if (insertedWear) existingWearItems.push(insertedWear);
        }
        wearCount++;
      }
    }

    // Record import in history to prevent future duplicates
    const newHistory = [...importHistory, { hash: hashKey, date: new Date().toISOString(), itemCount: parsedItems.length }];
    await supabase.from('organizations').update({
      settings: { ...(org.settings || {}), pool360ImportHistory: newHistory },
    }).eq('id', orgId);

    res.json({
      success: true,
      message: `Imported ${chemCount} chemical(s) and ${wearCount} wear item(s)`,
      imported: { chemicals: chemCount, wearItems: wearCount },
      totalParsed: parsedItems.length,
    });

  } catch (error) {
    console.error('Pool360 auto-import error:', error);
    const safeMessage = process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message;
    res.status(500).json({ error: 'Failed to process Pool360 PDF', message: safeMessage });
  }
});

// ============================================================
// AI Tech Diagnostic Assistant (RAG)
// ============================================================

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_CONTEXT_CHUNKS = 5;
const MAX_IMAGE_DIMENSION = 1568;
const SIMILARITY_THRESHOLD = 0.3;

// Initialize AI clients (lazy — only if env vars are set)
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Multer for image uploads (in-memory, max 10MB)
const techAssistUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const TECH_ASSIST_SYSTEM_PROMPT = `You are the Pool Authority AI Diagnostic Assistant, built for professional pool service technicians in the field.

ROLE: You help techs diagnose and fix pool equipment problems using your knowledge base of equipment manuals, troubleshooting guides, and field experience.

GUIDELINES:
- Be direct and practical — techs are standing in front of the equipment right now
- Lead with the most likely cause and fix, then list alternatives
- If an image is provided, analyze it closely for visible damage, wear, error codes, model numbers, or unusual conditions
- Reference specific part numbers when you can
- Always mention safety considerations (electrical, gas, chemical)
- If you identify the equipment make/model from the image, say so
- If you're not confident in a diagnosis, say so clearly — don't guess on safety-critical items
- Use plain language, not marketing speak
- If the issue is beyond field repair, say so and recommend what to tell the customer

FORMAT:
- Start with your assessment (1-2 sentences)
- Then give step-by-step diagnostic/repair instructions
- End with "If that doesn't resolve it:" and list next steps

KNOWLEDGE CONTEXT:
The following are relevant excerpts from our knowledge base. Use them to ground your response, but also apply general pool service knowledge:

{context}`;

async function getQueryEmbedding(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

async function searchKnowledge(embedding, filters = {}) {
  const { data, error } = await supabase.rpc('match_knowledge', {
    query_embedding: embedding,
    match_count: MAX_CONTEXT_CHUNKS,
    match_threshold: SIMILARITY_THRESHOLD,
    filter_manufacturer: filters.manufacturer || null,
    filter_equipment: filters.equipment || null,
    filter_source_type: filters.source_type || null,
  });
  if (error) {
    console.error('Knowledge search error:', error);
    return [];
  }
  return data || [];
}

async function processImage(imageBuffer) {
  try {
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();
    console.log(`Processing image: ${metadata.width}x${metadata.height} ${metadata.format}`);
    let processed = image;
    if (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION) {
      processed = image.resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const buffer = await processed.jpeg({ quality: 85 }).toBuffer();
    console.log(`Image processed: ${(buffer.length / 1024).toFixed(0)}KB base64`);
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: buffer.toString('base64'),
      },
    };
  } catch (err) {
    console.error('Image processing failed:', err.message);
    throw new Error(`Failed to process image: ${err.message}`);
  }
}

function formatContext(chunks) {
  if (chunks.length === 0) {
    return 'No specific matches found in the knowledge base. Use your general pool service expertise.';
  }
  return chunks
    .map((chunk, i) => {
      const source = [chunk.source_title, chunk.manufacturer, chunk.model_name]
        .filter(Boolean).join(' — ');
      return `--- Source ${i + 1}: ${source} (${Math.round(chunk.similarity * 100)}% match) ---\n${chunk.content}`;
    })
    .join('\n\n');
}

// POST /api/tech-assist — Main diagnostic endpoint
app.post('/api/tech-assist', rateLimit(20, 60000), optionalAuth, techAssistUpload.single('image'), async (req, res) => {
  try {
    if (!anthropic || !openai) {
      return res.status(500).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY and OPENAI_API_KEY.' });
    }
    if (!supabase) {
      return res.status(500).json({ error: 'Supabase not configured.' });
    }

    const { question, manufacturer, equipment, conversation_history } = req.body;
    if (!question || question.trim().length === 0) {
      return res.status(400).json({ error: 'Question is required' });
    }

    console.log(`[tech-assist] Question: "${question.slice(0, 80)}..." | Image: ${!!req.file} | History: ${conversation_history ? 'yes' : 'no'}`);

    // 1. Generate embedding for the question
    const embedding = await getQueryEmbedding(question);
    console.log('[tech-assist] Embedding generated');

    // 2. Search knowledge base
    const knowledgeChunks = await searchKnowledge(embedding, {
      manufacturer: manufacturer || null,
      equipment: equipment || null,
    });

    // 3. Build context
    const contextStr = formatContext(knowledgeChunks);
    const systemPrompt = TECH_ASSIST_SYSTEM_PROMPT.replace('{context}', contextStr);
    console.log(`[tech-assist] Knowledge chunks: ${knowledgeChunks.length}`);

    // 4. Build message content (text + optional image)
    const userContent = [];
    if (req.file) {
      const imageContent = await processImage(req.file.buffer);
      userContent.push(imageContent);
    }
    userContent.push({ type: 'text', text: question });

    // 5. Build messages array (support multi-turn conversation)
    const messages = [];
    if (conversation_history) {
      try {
        const history = JSON.parse(conversation_history);
        // Sanitize: only allow user/assistant roles with string content (prevent prompt injection)
        if (Array.isArray(history)) {
          for (const msg of history) {
            if (msg && ['user', 'assistant'].includes(msg.role) && typeof msg.content === 'string') {
              messages.push({ role: msg.role, content: msg.content });
            }
          }
        }
      } catch (e) { /* ignore malformed history */ }
    }
    messages.push({ role: 'user', content: userContent });
    console.log(`[tech-assist] Calling Claude (${CLAUDE_MODEL})...`);

    // 6. Call Claude (with timeout to prevent indefinite hangs)
    const AI_TIMEOUT = 60000; // 60 seconds
    let timeoutTimer;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('AI_TIMEOUT')), AI_TIMEOUT);
    });
    let response;
    try {
      response = await Promise.race([
        anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 2048,
          system: systemPrompt,
          messages: messages,
        }),
        timeoutPromise,
      ]);
    } catch (apiErr) {
      if (apiErr.message === 'AI_TIMEOUT') {
        console.error('[tech-assist] Claude API timed out after 60s');
        return res.status(504).json({ error: 'AI response timed out. Try again with a shorter question or without an image.' });
      }
      throw apiErr;
    } finally {
      clearTimeout(timeoutTimer);
    }
    console.log(`[tech-assist] Claude responded: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);

    const assistantMessage = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // 7. Log the diagnostic session (async, don't block response)
    supabase
      .from('diagnostic_sessions')
      .insert({
        question: question,
        has_image: !!req.file,
        response: assistantMessage,
        knowledge_ids: knowledgeChunks.map(c => c.id),
        equipment_tag: equipment || null,
        tech_id: req.user?.id || null,
      })
      .then(({ error }) => {
        if (error) console.error('Failed to log diagnostic session:', error);
      });

    // 8. Return response
    res.json({
      response: assistantMessage,
      sources: knowledgeChunks.map(c => ({
        title: c.source_title,
        manufacturer: c.manufacturer,
        equipment: c.equipment,
        model: c.model_name,
        similarity: Math.round(c.similarity * 100),
      })),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    });

  } catch (error) {
    console.error('Tech assist error:', error);
    res.status(500).json({ error: 'Diagnostic assistant error', message: error.message });
  }
});

// POST /api/tech-assist/rate — Rate a diagnostic session
app.post('/api/tech-assist/rate', optionalAuth, async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    const { session_id, rating, resolved } = req.body;
    if (!session_id || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Invalid rating data. session_id required, rating must be 1-5.' });
    }
    const query = supabase
      .from('diagnostic_sessions')
      .update({ rating, resolved: !!resolved })
      .eq('id', session_id);
    // If user is authenticated, only allow rating own sessions
    if (req.user) query.eq('tech_id', req.user.id);
    const { error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Knowledge Base PDF Upload — POST /api/knowledge/upload-pdf
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const EMBED_BATCH_SIZE = 50;

function chunkText(text, maxLength = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxLength * 0.5) end = breakPoint + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
  }
  return chunks.filter(c => c.length > 50); // Skip tiny chunks
}

function detectManufacturer(text) {
  const t = text.toLowerCase();
  const brands = [
    { key: 'pentair', patterns: ['pentair', 'intelliflo', 'intellichlor', 'intellicenter', 'mastertemp', 'superflow', 'whisperflo', 'easytouch', 'screenlogic'] },
    { key: 'hayward', patterns: ['hayward', 'aquarite', 'aqua rite', 'pro-grid', 'progrid', 'super pump', 'tristar', 'ecostar', 'omnilogic', 'swimpure'] },
    { key: 'jandy', patterns: ['jandy', 'zodiac', 'aqualink', 'stealth', 'flopro', 'laars', 'polaris'] },
    { key: 'raypak', patterns: ['raypak'] },
    { key: 'sta-rite', patterns: ['sta-rite', 'starite', 'max-e-therm', 'intellipro'] },
    { key: 'polaris', patterns: ['polaris'] },
    { key: 'waterway', patterns: ['waterway'] },
    { key: 'jacuzzi', patterns: ['jacuzzi'] },
  ];
  for (const brand of brands) {
    if (brand.patterns.some(p => t.includes(p))) return brand.key;
  }
  return null;
}

function detectEquipment(text) {
  const t = text.toLowerCase();
  const types = [
    { key: 'pump', patterns: ['pump', 'impeller', 'motor', 'priming', 'suction', 'gpm', 'flow rate'] },
    { key: 'filter', patterns: ['filter', 'cartridge', 'de grid', 'backwash', 'sand filter', 'multiport'] },
    { key: 'heater', patterns: ['heater', 'heat pump', 'burner', 'ignit', 'btu', 'thermostat', 'pilot', 'gas valve'] },
    { key: 'chlorinator', patterns: ['chlorinator', 'salt cell', 'salt chlor', 'aquarite', 'intellichlor', 'swg', 'salt water'] },
    { key: 'automation', patterns: ['automation', 'controller', 'aqualink', 'easytouch', 'intellicenter', 'omnilogic', 'screenlogic'] },
    { key: 'cleaner', patterns: ['cleaner', 'sweep', 'polaris', 'robot', 'suction cleaner', 'pressure cleaner'] },
    { key: 'light', patterns: ['pool light', 'spa light', 'led light', 'fiber optic', 'nicheless'] },
  ];
  for (const type of types) {
    if (type.patterns.some(p => t.includes(p))) return type.key;
  }
  return null;
}

function detectTags(text) {
  const t = text.toLowerCase();
  const tagMap = {
    'error-code': ['error code', 'fault code', 'diagnostic code', 'e0', 'err'],
    'noise': ['noise', 'grinding', 'screeching', 'humming', 'vibrat'],
    'leak': ['leak', 'drip', 'seep', 'water loss'],
    'prime': ['prime', 'priming', 'air lock', 'lost prime'],
    'pressure': ['pressure', 'psi', 'high pressure', 'low pressure'],
    'wiring': ['wiring', 'wire', 'electrical', 'voltage', 'amp'],
    'installation': ['install', 'setup', 'plumb', 'mounting'],
    'maintenance': ['maintenance', 'service', 'clean', 'inspect'],
    'chemistry': ['chemistry', 'chlorine', 'ph', 'alkalinity', 'calcium', 'cya'],
  };
  const tags = [];
  for (const [tag, patterns] of Object.entries(tagMap)) {
    if (patterns.some(p => t.includes(p))) tags.push(tag);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// File text extraction — supports PDF, DOCX, XLSX, CSV, TXT, HTML, images
// ---------------------------------------------------------------------------
async function extractTextFromFile(buffer, mimetype, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();

  // PDF — use pdfjs-dist (same as Pool360 import)
  if (mimetype === 'application/pdf' || ext === 'pdf') {
    try {
      const { allRows } = await parsePdfBuffer(buffer);
      return allRows.join('\n');
    } catch (e) {
      console.error('PDF parse error:', e.message);
      return '';
    }
  }

  // Word (.docx)
  if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // Excel (.xlsx, .xls)
  if (mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimetype === 'application/vnd.ms-excel' || ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const texts = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) texts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
    }
    return texts.join('\n\n');
  }

  // CSV
  if (mimetype === 'text/csv' || ext === 'csv') {
    return buffer.toString('utf-8');
  }

  // HTML
  if (mimetype === 'text/html' || ext === 'html' || ext === 'htm') {
    const html = buffer.toString('utf-8');
    // Strip tags, decode entities, clean up whitespace
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Plain text (.txt, .md, .log, .rtf, .xml, .json)
  if (mimetype?.startsWith('text/') || ['txt', 'md', 'log', 'rtf', 'xml', 'json', 'cfg', 'ini'].includes(ext)) {
    return buffer.toString('utf-8');
  }

  // Images — use Claude vision to extract text
  if (mimetype?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff'].includes(ext)) {
    if (!anthropic) throw new Error('Image text extraction requires ANTHROPIC_API_KEY');
    // Resize if needed
    let imgBuffer = buffer;
    let mediaType = mimetype || 'image/jpeg';
    try {
      const img = sharp(buffer);
      const meta = await img.metadata();
      if (meta.width > 2000 || meta.height > 2000) {
        imgBuffer = await img.resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        mediaType = 'image/jpeg';
      }
    } catch (e) { /* use original buffer */ }

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imgBuffer.toString('base64') } },
          { type: 'text', text: 'Extract ALL text from this image. Include every word, number, label, model number, part number, specification, and instruction you can read. Format it as clean readable text. If this is a wiring diagram or schematic, describe the connections and components.' }
        ]
      }]
    });
    return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  throw new Error(`Unsupported file type: ${ext || mimetype}. Supported: PDF, DOCX, XLSX, CSV, TXT, HTML, MD, images (JPG/PNG/WEBP)`);
}

// ---------------------------------------------------------------------------
// ZIP extraction — recursively unzips and returns flat list of {name, buffer}
// ---------------------------------------------------------------------------
const SUPPORTED_EXTENSIONS = new Set(['pdf','docx','xlsx','xls','csv','txt','html','htm','md','log','rtf','xml','json','cfg','ini','jpg','jpeg','png','webp','gif','bmp','tiff','zip']);

const MAX_ZIP_DEPTH = 3;
const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024; // 50MB max total extracted size
const MAX_ZIP_FILE_COUNT = 500; // Max files in a single ZIP

async function extractFilesFromZip(buffer, depth = 0, totalSize = { bytes: 0 }) {
  if (depth > MAX_ZIP_DEPTH) throw new Error('ZIP nesting too deep (max 3 levels)');
  const zip = await JSZip.loadAsync(buffer);
  const files = [];
  let fileCount = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    // Skip macOS resource forks and hidden files
    if (path.startsWith('__MACOSX') || path.startsWith('.') || path.includes('/.')) continue;
    const ext = path.split('.').pop().toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
    fileCount++;
    if (fileCount > MAX_ZIP_FILE_COUNT) {
      throw new Error(`ZIP contains too many files (max ${MAX_ZIP_FILE_COUNT})`);
    }
    const buf = await entry.async('nodebuffer');
    totalSize.bytes += buf.length;
    if (totalSize.bytes > MAX_EXTRACTED_SIZE) {
      throw new Error(`Extracted content exceeds ${MAX_EXTRACTED_SIZE / 1024 / 1024}MB limit`);
    }
    if (ext === 'zip') {
      // Recursively unzip nested zips
      const nested = await extractFilesFromZip(buf, depth + 1, totalSize);
      files.push(...nested);
    } else {
      files.push({ name: path.split('/').pop(), buffer: buf, ext });
    }
  }
  return files;
}

// Guess mimetype from extension
function mimeFromExt(ext) {
  const map = {
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
    csv: 'text/csv', txt: 'text/plain', html: 'text/html', htm: 'text/html', md: 'text/plain',
    log: 'text/plain', rtf: 'text/plain', xml: 'text/xml', json: 'application/json',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    bmp: 'image/bmp', tiff: 'image/tiff',
  };
  return map[ext] || 'application/octet-stream';
}

// Process a single file → returns { title, chunks[], metadata }
async function processFileForKB(buffer, mimetype, filename) {
  console.log(`KB processing: ${filename} | mime: ${mimetype} | size: ${buffer.length} bytes`);
  const fullText = await extractTextFromFile(buffer, mimetype, filename);
  console.log(`KB extracted: ${filename} → ${fullText.length} chars`);
  if (fullText.length < 50) return null;
  const title = filename.replace(/\.[^.]+$/, '');
  const chunks = chunkText(fullText);
  return {
    title,
    chunks,
    manufacturer: detectManufacturer(fullText),
    equipment: detectEquipment(fullText),
    tags: detectTags(fullText),
    filename,
    mimetype,
    textLength: fullText.length,
  };
}

// Multer for knowledge base uploads (in-memory, max 50MB for zips)
const kbUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// In-memory job tracker for background KB processing
const kbJobs = new Map();

app.post('/api/knowledge/upload', rateLimit(5, 60000), authenticateUser, kbUpload.single('file'), async (req, res) => {
  try {
    if (!openai) return res.status(500).json({ error: 'OpenAI not configured (set OPENAI_API_KEY)' });
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    const isZip = ext === 'zip' || req.file.mimetype === 'application/zip' || req.file.mimetype === 'application/x-zip-compressed';

    // 1. Build list of files to process
    let fileList;
    if (isZip) {
      const extracted = await extractFilesFromZip(req.file.buffer);
      if (extracted.length === 0) return res.status(400).json({ error: 'ZIP contained no supported files' });
      fileList = extracted.map(f => ({ buffer: f.buffer, mimetype: mimeFromExt(f.ext), filename: f.name }));
    } else {
      fileList = [{ buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }];
    }

    // Generate a job ID and respond immediately
    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    kbJobs.set(jobId, { status: 'processing', filename: req.file.originalname, startedAt: Date.now() });

    // Respond right away so Render doesn't timeout
    res.json({ success: true, jobId, message: `Processing ${fileList.length} file(s) in background...`, status: 'processing' });

    // Process in background (after response sent)
    processKBFiles(jobId, fileList).catch(err => {
      console.error('KB background processing error:', err);
      kbJobs.set(jobId, { status: 'error', error: err.message });
      // Clean up failed jobs after 10 minutes (prevent memory leak)
      setTimeout(() => kbJobs.delete(jobId), 10 * 60 * 1000);
    });

  } catch (error) {
    console.error('Knowledge upload error:', error);
    res.status(500).json({ error: 'Failed to process file', message: error.message });
  }
});

// Background KB file processing
async function processKBFiles(jobId, fileList) {
  const results = [];
  const errors = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < fileList.length; i += CONCURRENCY) {
    const batch = fileList.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(f => processFileForKB(f.buffer, f.mimetype, f.filename))
    );
    for (let j = 0; j < batchResults.length; j++) {
      if (batchResults[j].status === 'fulfilled' && batchResults[j].value) {
        results.push(batchResults[j].value);
      } else if (batchResults[j].status === 'rejected') {
        errors.push({ file: batch[j].filename, error: batchResults[j].reason?.message || 'Unknown error' });
      }
    }
  }

  if (results.length === 0) {
    kbJobs.set(jobId, { status: 'error', error: 'No readable text found in uploaded file(s)', errors });
    return;
  }

  // Collect ALL chunks, embed, insert
  const allChunkMeta = [];
  for (let fi = 0; fi < results.length; fi++) {
    for (const chunk of results[fi].chunks) {
      allChunkMeta.push({ text: chunk, fileIdx: fi });
    }
  }

  kbJobs.set(jobId, { status: 'embedding', filesProcessed: results.length, totalChunks: allChunkMeta.length });

  const allTexts = allChunkMeta.map(c => c.text);
  const allEmbeddings = [];
  const BIG_BATCH = 200;
  for (let i = 0; i < allTexts.length; i += BIG_BATCH) {
    const batch = allTexts.slice(i, i + BIG_BATCH);
    const response = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
    allEmbeddings.push(...response.data.map(item => item.embedding));
  }

  const insertRows = allChunkMeta.map((cm, i) => {
    const file = results[cm.fileIdx];
    return {
      content: cm.text,
      embedding: allEmbeddings[i],
      source_type: 'manual',
      manufacturer: file.manufacturer,
      equipment: file.equipment,
      model_name: null,
      tags: file.tags,
      source_title: file.title,
      source_url: null,
      metadata: { filename: file.filename, fileType: file.mimetype },
    };
  });

  let inserted = 0;
  const INSERT_BATCH = 500;
  for (let i = 0; i < insertRows.length; i += INSERT_BATCH) {
    const batch = insertRows.slice(i, i + INSERT_BATCH);
    const { error } = await supabase.from('knowledge_base').insert(batch);
    if (error) { console.error('KB insert error:', error.message); continue; }
    inserted += batch.length;
  }

  const totalChars = results.reduce((sum, r) => sum + r.textLength, 0);
  kbJobs.set(jobId, {
    status: 'done',
    message: `Ingested ${results.length} file(s) — ${inserted} chunks (${Math.round(totalChars / 1000)}k chars)`,
    filesProcessed: results.length,
    chunks: inserted,
    files: results.map(r => ({ title: r.title, chunks: r.chunks.length, manufacturer: r.manufacturer, equipment: r.equipment })),
    errors: errors.length > 0 ? errors : undefined,
  });

  // Clean up job after 10 minutes
  setTimeout(() => kbJobs.delete(jobId), 10 * 60 * 1000);
}

// Poll job status
app.get('/api/knowledge/job/:jobId', async (req, res) => {
  const job = kbJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(job);
});

// GET /api/knowledge/stats — Get knowledge base stats
app.get('/api/knowledge/stats', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    const { data, error } = await supabase
      .from('knowledge_base')
      .select('id, source_title, manufacturer, equipment, source_type, created_at');
    if (error) return res.status(500).json({ error: error.message });

    // Group by source_title
    const sources = {};
    for (const row of (data || [])) {
      const key = row.source_title || 'Unknown';
      if (!sources[key]) {
        sources[key] = { title: key, chunks: 0, manufacturer: row.manufacturer, equipment: row.equipment, source_type: row.source_type, created_at: row.created_at };
      }
      sources[key].chunks++;
    }

    res.json({ total_chunks: (data || []).length, sources: Object.values(sources) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// Email Endpoints
// ============================================================

// POST /api/send-email — Generic email (used for contracts, water test results)
app.post('/api/send-email', rateLimit(10, 60000), authenticateUser, async (req, res) => {
  try {
    const { to, subject, html, from } = req.body;
    if (!to || !subject || !html) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, html' });
    }
    await sendEmail(to, subject, html, from);
    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (error) {
    console.error('Send email error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /send-invoice — Monthly invoice & payment reminder emails
app.post('/send-invoice', rateLimit(10, 60000), authenticateUser, async (req, res) => {
  try {
    const { to, template, data, companySettings, paymentLink, attachment } = req.body;
    if (!to || !template) {
      return res.status(400).json({ error: 'Missing required fields: to, template' });
    }

    const companyName = companySettings?.companyName || 'Pool Authority';
    const allData = { ...data, company_name: companyName };
    const subject = processTemplate(template.subject, allData);
    let body = processTemplate(template.body, allData);

    // Add payment link button if provided
    if (paymentLink) {
      body += `\n\n**Pay Online:**\n[Click here to pay securely](${paymentLink})`;
    }

    const htmlBody = buildEmailHtml(textToHtml(body), companySettings);
    const attachments = attachment ? [{ filename: attachment.filename, content: attachment.content }] : undefined;
    await sendEmail(to, subject, htmlBody, companyName, attachments);
    res.json({ success: true, message: `Invoice email sent to ${to}` });
  } catch (error) {
    console.error('Send invoice error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /send-weekly-update — Weekly service updates, job confirmations, job completions
app.post('/send-weekly-update', rateLimit(10, 60000), authenticateUser, async (req, res) => {
  try {
    const { to, template, data, companySettings, paymentLink } = req.body;
    if (!to || !template) {
      return res.status(400).json({ error: 'Missing required fields: to, template' });
    }

    const companyName = companySettings?.companyName || 'Pool Authority';
    const allData = { ...data, company_name: companyName };
    const subject = processTemplate(template.subject, allData);
    let body = processTemplate(template.body, allData);

    if (paymentLink) {
      body += `\n\n**Pay Online:**\n[Click here to pay securely](${paymentLink})`;
    }

    const bodyHtml = textToHtml(body) + buildPhotosHtml(data?.photo_urls);
    const htmlBody = buildEmailHtml(bodyHtml, companySettings);
    await sendEmail(to, subject, htmlBody, companyName);
    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (error) {
    console.error('Send weekly update error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /send-quote — Quote emails
app.post('/send-quote', rateLimit(10, 60000), authenticateUser, async (req, res) => {
  try {
    const { to, template, data, companySettings, attachment } = req.body;
    if (!to || !template) {
      return res.status(400).json({ error: 'Missing required fields: to, template' });
    }

    const companyName = companySettings?.companyName || 'Pool Authority';
    const allData = { ...data, company_name: companyName };
    const subject = processTemplate(template.subject, allData);
    const body = processTemplate(template.body, allData);

    const htmlBody = buildEmailHtml(textToHtml(body), companySettings);
    const attachments = attachment ? [{ filename: attachment.filename, content: attachment.content }] : undefined;
    await sendEmail(to, subject, htmlBody, companyName, attachments);
    res.json({ success: true, message: `Quote email sent to ${to}` });
  } catch (error) {
    console.error('Send quote error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  const isLive = process.env.STRIPE_SECRET_KEY?.startsWith('sk_live');
  res.json({
    status: 'Pool Authority Payment Server Running',
    version: '1.4.0',
    stripe: process.env.STRIPE_SECRET_KEY ? (isLive ? 'connected (live)' : 'connected (test)') : 'not configured',
    email: RESEND_API_KEY ? 'configured' : 'not configured',
    pool360Import: supabase ? 'enabled' : 'disabled',
    techAssist: (anthropic && openai) ? 'enabled' : 'disabled (set ANTHROPIC_API_KEY + OPENAI_API_KEY)'
  });
});

// Create a Stripe Checkout Session
app.post('/api/create-checkout-session', optionalAuth, async (req, res) => {
  try {
    const { 
      customerName, 
      customerEmail, 
      amount, 
      description, 
      invoiceNumber,
      customerId,
      successUrl,
      cancelUrl 
    } = req.body;

    // Validate required fields
    const parsedAmount = typeof amount === 'number' ? amount : parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0 || parsedAmount > 999999 || isNaN(parsedAmount)) {
      return res.status(400).json({ error: 'Valid amount is required (between $0.01 and $999,999)' });
    }

    // Create Stripe Checkout Session with idempotency key to prevent duplicate charges
    const unitAmount = Math.round((parsedAmount + Number.EPSILON) * 100); // Safe cent conversion
    const idempotencyKey = `checkout_${invoiceNumber || ''}_${customerId || ''}_${unitAmount}_${Date.now()}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: description || 'Pool Authority Service',
              description: `Invoice #${invoiceNumber || 'N/A'}`,
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl || 'https://pool-authority.vercel.app/payment-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl || 'https://pool-authority.vercel.app/payment-cancelled',
      customer_email: customerEmail || undefined,
      metadata: {
        customerName,
        customerId,
        invoiceNumber,
        description
      },
    }, { idempotencyKey });

    // Store session info
    paymentSessions.set(session.id, {
      id: session.id,
      customerName,
      customerEmail,
      customerId,
      amount,
      invoiceNumber,
      status: 'pending',
      createdAt: new Date().toISOString(),
      paymentUrl: session.url
    });

    res.json({
      success: true,
      sessionId: session.id,
      paymentUrl: session.url,
      invoiceNumber
    });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ 
      error: 'Failed to create payment session',
      message: error.message 
    });
  }
});

// Create a Payment Link (reusable)
app.post('/api/create-payment-link', optionalAuth, async (req, res) => {
  try {
    const { amount, description, invoiceNumber } = req.body;

    if (!amount || typeof amount !== 'number' || !isFinite(amount) || amount <= 0 || amount > 999999.99) {
      return res.status(400).json({ error: 'Valid amount is required (must be between $0.01 and $999,999.99)' });
    }

    // First create a price
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: Math.round((amount + Number.EPSILON) * 100),
      product_data: {
        name: description || 'Pool Authority Service',
      },
    });

    // Then create the payment link
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price: price.id,
          quantity: 1,
        },
      ],
      metadata: {
        invoiceNumber,
        description
      },
    });

    res.json({
      success: true,
      paymentUrl: paymentLink.url,
      paymentLinkId: paymentLink.id
    });

  } catch (error) {
    console.error('Error creating payment link:', error);
    const safeMessage = process.env.NODE_ENV === 'production' ? 'Failed to create payment link' : error.message;
    res.status(500).json({
      error: 'Failed to create payment link',
      message: safeMessage
    });
  }
});

// Check payment status
app.get('/api/payment-status/:sessionId', optionalAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    res.json({
      success: true,
      status: session.payment_status,
      amountTotal: session.amount_total / 100,
      customerEmail: session.customer_email,
      metadata: session.metadata
    });

  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({ 
      error: 'Failed to check payment status',
      message: error.message 
    });
  }
});

// Webhook handler (route registered above express.json() middleware for raw body access)
async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else if (process.env.NODE_ENV === 'production') {
      // Require webhook secret in production — prevent forged events
      console.error('STRIPE_WEBHOOK_SECRET not set in production — rejecting webhook');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    } else {
      // Allow unverified webhooks only in development
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      console.log('Payment successful!', {
        sessionId: session.id,
        amount: session.amount_total / 100,
        customer: session.customer_email,
        metadata: session.metadata
      });

      // Update payment session status
      if (paymentSessions.has(session.id)) {
        const paymentSession = paymentSessions.get(session.id);
        paymentSession.status = 'paid';
        paymentSession.paidAt = new Date().toISOString();
        paymentSessions.set(session.id, paymentSession);
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const failedPayment = event.data.object;
      console.log('Payment failed:', failedPayment.id);
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
}

// Get all payment sessions (for admin)
app.get('/api/payments', authenticateUser, (req, res) => {
  const payments = Array.from(paymentSessions.values());
  res.json({
    success: true,
    payments: payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  });
});

// Global error handler — catch unhandled Express errors
app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', err);
  const safeMessage = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  res.status(500).json({ error: safeMessage });
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
🏊 Pool Authority Payment Server
================================
Server running on port ${PORT}
Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'Connected (LIVE)' : 'Connected (Test Mode)'}

Endpoints:
- POST /api/create-checkout-session - Create payment session
- POST /api/create-payment-link - Create reusable payment link
- GET  /api/payment-status/:sessionId - Check payment status
- POST /api/webhook - Stripe webhook handler
- GET  /api/payments - List all payments
- POST /api/process-pool360 - Auto-import Pool360 PDF
- POST /api/tech-assist - AI diagnostic assistant
- POST /api/tech-assist/rate - Rate diagnostic session
- POST /api/knowledge/upload - Upload file to knowledge base
- GET  /api/knowledge/stats - Knowledge base stats
- POST /api/send-email - Send generic HTML email
- POST /send-invoice - Send invoice/payment reminder
- POST /send-weekly-update - Send service update/job emails
- POST /send-quote - Send quote email

Pool360 Import: ${supabase ? 'Enabled' : 'Disabled (set SUPABASE_SERVICE_ROLE_KEY)'}
Email: ${RESEND_API_KEY ? 'Configured (Resend)' : 'Not configured (set RESEND_API_KEY)'}
AI Tech Assist: ${(anthropic && openai) ? 'Enabled' : 'Disabled (set ANTHROPIC_API_KEY + OPENAI_API_KEY)'}
Ready!
  `);
});

module.exports = app;
