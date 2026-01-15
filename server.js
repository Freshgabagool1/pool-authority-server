// Pool Authority Server - Stripe Payments + Gmail Email
// Deploy to Railway for production use

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');

const app = express();
app.use(cors());
app.use(express.json());

// Environment Variables (set these in Railway)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_YOUR_KEY_HERE';
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const PORT = process.env.PORT || 3001;

// Initialize Stripe
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Initialize Gmail transporter (only if credentials provided)
let emailTransporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD
    }
  });
  
  // Verify connection
  emailTransporter.verify((error, success) => {
    if (error) {
      console.log('❌ Email configuration error:', error.message);
    } else {
      console.log('✅ Email server ready');
    }
  });
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Pool Authority Server Running',
    email: emailTransporter ? 'configured' : 'not configured',
    stripe: 'configured'
  });
});

// ============================================
// STRIPE ENDPOINTS
// ============================================

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { amount, customerEmail, description, customerName, metadata } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: description || 'Pool Service',
            description: `Invoice for ${customerName || 'Customer'}`,
          },
          unit_amount: Math.round(amount * 100), // Stripe uses cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin || 'http://localhost:3000'}?payment=success`,
      cancel_url: `${req.headers.origin || 'http://localhost:3000'}?payment=cancelled`,
      metadata: metadata || {},
    };

    // Add customer email if provided
    if (customerEmail) {
      sessionConfig.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    
    res.json({ 
      sessionId: session.id,
      url: session.url 
    });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get payment status
app.get('/payment-status/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      status: session.payment_status,
      customerEmail: session.customer_email,
      amountTotal: session.amount_total / 100
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EMAIL ENDPOINTS
// ============================================

// Helper: Process merge tags in template
function processTemplate(template, data) {
  let result = template;
  
  // Simple merge tags
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(regex, data[key] || '');
  });
  
  // Process conditionals {{#if condition}}...{{/if}}
  result = result.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, condition, content) => {
    return data[condition] ? content : '';
  });
  
  // Convert **bold** to HTML bold
  result = result.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Convert newlines to <br> for HTML
  result = result.replace(/\n/g, '<br>');
  
  return result;
}

// Helper: Create HTML email wrapper
function wrapInHtmlEmail(content, companySettings) {
  const primaryColor = companySettings.primaryColor || '#1e3a5f';
  const accentColor = companySettings.accentColor || '#5bb4d8';
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background: #f5f5f5; }
    .container { max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, ${primaryColor} 0%, ${accentColor} 100%); color: white; padding: 30px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; }
    .content { padding: 30px; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 12px; color: #666; }
    .btn { display: inline-block; padding: 12px 30px; background: ${primaryColor}; color: white; text-decoration: none; border-radius: 6px; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${companySettings.logoUrl ? `<img src="${companySettings.logoUrl}" alt="Logo" style="max-height: 60px; margin-bottom: 10px;">` : ''}
      <h1>${companySettings.companyName || 'Pool Service'}</h1>
    </div>
    <div class="content">
      ${content}
    </div>
    <div class="footer">
      ${companySettings.companyName || ''}<br>
      ${companySettings.address || ''}<br>
      ${companySettings.phone || ''} | ${companySettings.email || ''}
    </div>
  </div>
</body>
</html>`;
}

// Send Weekly Update Email
app.post('/send-weekly-update', async (req, res) => {
  if (!emailTransporter) {
    return res.status(400).json({ error: 'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.' });
  }

  try {
    const { to, template, data, companySettings } = req.body;
    
    if (!to) {
      return res.status(400).json({ error: 'Recipient email required' });
    }

    const mergeData = {
      company_name: companySettings?.companyName || 'Pool Service',
      owner_name: companySettings?.ownerName || '',
      company_phone: companySettings?.phone || '',
      company_email: companySettings?.email || '',
      ...data
    };

    const subject = processTemplate(template.subject, mergeData);
    const bodyHtml = wrapInHtmlEmail(processTemplate(template.body, mergeData), companySettings || {});

    const mailOptions = {
      from: `"${companySettings?.companyName || 'Pool Service'}" <${GMAIL_USER}>`,
      to: to,
      subject: subject,
      html: bodyHtml
    };

    await emailTransporter.sendMail(mailOptions);
    
    res.json({ success: true, message: 'Weekly update sent successfully' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send Monthly Invoice Email
app.post('/send-invoice', async (req, res) => {
  if (!emailTransporter) {
    return res.status(400).json({ error: 'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.' });
  }

  try {
    const { to, template, data, companySettings, paymentLink } = req.body;
    
    if (!to) {
      return res.status(400).json({ error: 'Recipient email required' });
    }

    const mergeData = {
      company_name: companySettings?.companyName || 'Pool Service',
      owner_name: companySettings?.ownerName || '',
      company_phone: companySettings?.phone || '',
      company_email: companySettings?.email || '',
      payment_link: paymentLink || '',
      ...data
    };

    const subject = processTemplate(template.subject, mergeData);
    let bodyContent = processTemplate(template.body, mergeData);
    
    // Add payment button if link provided
    if (paymentLink) {
      bodyContent += `<br><br><a href="${paymentLink}" class="btn">💳 Pay Now</a>`;
    }
    
    const bodyHtml = wrapInHtmlEmail(bodyContent, companySettings || {});

    const mailOptions = {
      from: `"${companySettings?.companyName || 'Pool Service'}" <${GMAIL_USER}>`,
      to: to,
      subject: subject,
      html: bodyHtml
    };

    await emailTransporter.sendMail(mailOptions);
    
    res.json({ success: true, message: 'Invoice sent successfully' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send Quote Email
app.post('/send-quote', async (req, res) => {
  if (!emailTransporter) {
    return res.status(400).json({ error: 'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.' });
  }

  try {
    const { to, template, data, companySettings } = req.body;
    
    if (!to) {
      return res.status(400).json({ error: 'Recipient email required' });
    }

    const mergeData = {
      company_name: companySettings?.companyName || 'Pool Service',
      owner_name: companySettings?.ownerName || '',
      company_phone: companySettings?.phone || '',
      company_email: companySettings?.email || '',
      ...data
    };

    const subject = processTemplate(template.subject, mergeData);
    const bodyHtml = wrapInHtmlEmail(processTemplate(template.body, mergeData), companySettings || {});

    const mailOptions = {
      from: `"${companySettings?.companyName || 'Pool Service'}" <${GMAIL_USER}>`,
      to: to,
      subject: subject,
      html: bodyHtml
    };

    await emailTransporter.sendMail(mailOptions);
    
    res.json({ success: true, message: 'Quote sent successfully' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generic send email endpoint
app.post('/send-email', async (req, res) => {
  if (!emailTransporter) {
    return res.status(400).json({ error: 'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.' });
  }

  try {
    const { to, subject, body, companySettings } = req.body;
    
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required' });
    }

    const bodyHtml = wrapInHtmlEmail(body.replace(/\n/g, '<br>'), companySettings || {});

    const mailOptions = {
      from: `"${companySettings?.companyName || 'Pool Service'}" <${GMAIL_USER}>`,
      to: to,
      subject: subject,
      html: bodyHtml
    };

    await emailTransporter.sendMail(mailOptions);
    
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test email configuration
app.post('/test-email', async (req, res) => {
  if (!emailTransporter) {
    return res.status(400).json({ error: 'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD.' });
  }

  try {
    const { to } = req.body;
    
    await emailTransporter.sendMail({
      from: GMAIL_USER,
      to: to || GMAIL_USER,
      subject: 'Pool Authority - Email Test',
      html: '<h1>✅ Email is working!</h1><p>Your Pool Authority email configuration is correct.</p>'
    });
    
    res.json({ success: true, message: 'Test email sent!' });
  } catch (error) {
    console.error('Email test error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
🏊 Pool Authority Server Running
================================
Port: ${PORT}
Stripe: ${STRIPE_SECRET_KEY ? '✅ Configured' : '❌ Missing STRIPE_SECRET_KEY'}
Email: ${emailTransporter ? '✅ Configured' : '❌ Missing GMAIL_USER/GMAIL_APP_PASSWORD'}

Endpoints:
- POST /create-checkout-session - Create Stripe payment
- POST /send-weekly-update - Send weekly service email
- POST /send-invoice - Send monthly invoice email
- POST /send-quote - Send quote email
- POST /test-email - Test email configuration
  `);
});
