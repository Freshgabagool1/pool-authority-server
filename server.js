// Pool Authority - Stripe Payment Server + Pool360 Auto-Import
// This server handles secure Stripe payment processing and Pool360 invoice imports

const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Your Stripe Secret Key (use environment variable in production!)
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Supabase client with service role key (for auto-import writes)
const supabaseUrl = process.env.SUPABASE_URL || 'https://visqepsesgcarjcnvvbx.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;

// Middleware
app.use(cors({
  origin: '*', // In production, set this to your specific domain
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));
app.use(express.json({ limit: '10mb' }));

// Store for payment sessions (in production, use a real database)
const paymentSessions = new Map();

// ============================================================
// Pool360 Auto-Import Helpers
// ============================================================

const categorizePool360Item = (description) => {
  const desc = description.toLowerCase();
  const chemicalKeywords = ['shock','chlorine','chlor','acid','algaecide','antifreeze','ph ','alkalinity',
    'stabilizer','sanitizer','oxidizer','calcium','cyanuric','bromine','stain','scale',
    'clarifier','enzyme','phosphate','muriatic','soda ash','bicarb','dichlor','trichlor'];
  const wearKeywords = ['plug','gasket','o-ring','basket','valve','lid','cover','guard',
    'adapter','fitting','impeller','seal','diverter','skimmer','drain','cap','plate',
    'flap','weir','eyeball','return'];
  if (chemicalKeywords.some(k => desc.includes(k))) return 'chemical';
  if (wearKeywords.some(k => desc.includes(k))) return 'wear_item';
  return 'equipment';
};

const parsePdfBuffer = async (buffer) => {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const allRows = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const yMap = {};
    content.items.forEach(item => {
      const y = Math.round(item.transform[5]);
      if (!yMap[y]) yMap[y] = [];
      yMap[y].push({ str: item.str, x: item.transform[4] });
    });
    const sortedYs = Object.keys(yMap).map(Number).sort((a, b) => b - a);
    sortedYs.forEach(y => {
      const row = yMap[y].sort((a, b) => a.x - b.x).map(it => it.str).join(' ').trim();
      if (row) allRows.push(row);
    });
  }

  const items = [];
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const productMatch = row.match(/(\d+)\s+([A-Z]{2,4}-\d{2,3}-\d{4})/);
    if (!productMatch) continue;
    const uomMatch = row.match(/(EA|CS|BX|BG|PL|BK|GL|DZ|CT)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)/);
    if (!uomMatch) continue;
    let description = '';
    for (let j = i + 1; j < Math.min(i + 3, allRows.length); j++) {
      const descRow = allRows[j].trim();
      if (!descRow || descRow.match(/^\d+\s+[A-Z]{2,4}-\d{2,3}-\d{4}/)) break;
      description = descRow.replace(/\s+[A-Z]-\d{2}-[A-Z]\s*$/, '').trim();
      if (description) break;
    }
    if (!description) description = `Product ${productMatch[2]}`;
    items.push({
      lineNum: parseInt(productMatch[1]),
      productCode: productMatch[2],
      description,
      unitOfMeasure: uomMatch[1],
      openQty: parseInt(uomMatch[2]),
      orderedQty: parseInt(uomMatch[3]),
      shippedQty: parseInt(uomMatch[4]),
      backOrder: parseInt(uomMatch[5]),
      unitPrice: parseFloat(uomMatch[6]),
      totalPrice: parseFloat(uomMatch[7]),
    });
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
    if (!storedKey || storedKey !== apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // Parse the PDF
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const parsedItems = await parsePdfBuffer(pdfBuffer);

    if (parsedItems.length === 0) {
      return res.json({ success: true, message: 'No line items found in PDF', imported: { chemicals: 0, wearItems: 0 } });
    }

    // Load saved mappings
    const savedMappings = org.settings?.pool360Mappings || {};

    // Categorize and import
    let chemCount = 0, wearCount = 0;

    // Fetch existing inventory
    const { data: existingChemicals } = await supabase
      .from('chemical_inventory')
      .select('*')
      .eq('org_id', orgId);

    const { data: existingWearItems } = await supabase
      .from('wear_items')
      .select('*')
      .eq('org_id', orgId);

    for (const item of parsedItems) {
      const mapping = savedMappings[item.productCode];
      const itemType = mapping?.itemType || categorizePool360Item(item.description);
      const itemName = mapping?.itemName || item.description;
      const conversionFactor = mapping?.conversionFactor || 1;

      if (itemType === 'chemical') {
        const actualQty = item.shippedQty * conversionFactor;
        const costPerUnit = conversionFactor > 1 ? item.unitPrice / conversionFactor : item.unitPrice;
        const usageUnit = mapping?.usageUnit || 'lbs';

        const existing = (existingChemicals || []).find(c =>
          c.name.toLowerCase() === itemName.toLowerCase()
        );

        if (existing) {
          await supabase.from('chemical_inventory').update({
            quantity: existing.quantity + actualQty,
            cost_per_unit: costPerUnit,
          }).eq('id', existing.id);
        } else {
          await supabase.from('chemical_inventory').insert({
            org_id: orgId,
            name: itemName,
            category: mapping?.category || '',
            quantity: actualQty,
            unit: usageUnit,
            cost_per_unit: costPerUnit,
            supplier: 'Pool360/SCP',
          });
        }
        chemCount++;
      } else {
        const exists = (existingWearItems || []).some(w =>
          w.name.toLowerCase() === itemName.toLowerCase()
        );
        if (!exists) {
          await supabase.from('wear_items').insert({
            org_id: orgId,
            name: itemName,
            price: item.unitPrice,
            description: `Pool360: ${item.productCode}`,
          });
          wearCount++;
        }
      }
    }

    res.json({
      success: true,
      message: `Imported ${chemCount} chemical(s) and ${wearCount} wear item(s)`,
      imported: { chemicals: chemCount, wearItems: wearCount },
      totalParsed: parsedItems.length,
    });

  } catch (error) {
    console.error('Pool360 auto-import error:', error);
    res.status(500).json({ error: 'Failed to process Pool360 PDF', message: error.message });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'Pool Authority Payment Server Running',
    version: '1.1.0',
    stripe: 'connected',
    pool360Import: supabase ? 'enabled' : 'disabled'
  });
});

// Create a Stripe Checkout Session
app.post('/api/create-checkout-session', async (req, res) => {
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
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    // Create Stripe Checkout Session
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
            unit_amount: Math.round(amount * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl || 'https://poolauthority.com/payment-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancelUrl || 'https://poolauthority.com/payment-cancelled',
      customer_email: customerEmail || undefined,
      metadata: {
        customerName,
        customerId,
        invoiceNumber,
        description
      },
    });

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
app.post('/api/create-payment-link', async (req, res) => {
  try {
    const { amount, description, invoiceNumber } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    // First create a price
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: Math.round(amount * 100),
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
    res.status(500).json({ 
      error: 'Failed to create payment link',
      message: error.message 
    });
  }
});

// Check payment status
app.get('/api/payment-status/:sessionId', async (req, res) => {
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

// Webhook endpoint for Stripe events
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // For testing without webhook signature verification
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
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

    case 'payment_intent.payment_failed':
      const failedPayment = event.data.object;
      console.log('Payment failed:', failedPayment.id);
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// Get all payment sessions (for admin)
app.get('/api/payments', (req, res) => {
  const payments = Array.from(paymentSessions.values());
  res.json({
    success: true,
    payments: payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
🏊 Pool Authority Payment Server
================================
Server running on port ${PORT}
Stripe: Connected (Test Mode)

Endpoints:
- POST /api/create-checkout-session - Create payment session
- POST /api/create-payment-link - Create reusable payment link
- GET  /api/payment-status/:sessionId - Check payment status
- POST /api/webhook - Stripe webhook handler
- GET  /api/payments - List all payments
- POST /api/process-pool360 - Auto-import Pool360 PDF

Pool360 Import: ${supabase ? 'Enabled' : 'Disabled (set SUPABASE_SERVICE_ROLE_KEY)'}
Ready to accept payments!
  `);
});

module.exports = app;
