# Pool Authority Server

Backend server for Pool Authority app - handles Stripe payments and Gmail email sending.

## Features

- 💳 **Stripe Payments** - Create checkout sessions for customer payments
- 📧 **Gmail Email** - Send invoices, quotes, and weekly updates via Gmail SMTP
- 🎨 **Custom Templates** - Uses your company branding and customizable templates

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Set environment variables (or create .env file):
```
STRIPE_SECRET_KEY=sk_test_your_key_here
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-16-char-app-password
PORT=3001
```

3. Start the server:
```bash
npm start
```

## Gmail App Password Setup

1. Go to Google Account Security: https://myaccount.google.com/security
2. Enable 2-Step Verification if not already enabled
3. Go to App Passwords: https://myaccount.google.com/apppasswords
4. Select "Mail" and your device
5. Click "Generate"
6. Copy the 16-character password (use this as GMAIL_APP_PASSWORD)

## Deploy to Railway

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/pool-authority-server.git
git push -u origin main
```

### Step 2: Deploy on Railway

1. Go to railway.app and sign up/login
2. Click "New Project" > "Deploy from GitHub repo"
3. Select your pool-authority-server repository
4. Railway will auto-detect Node.js and deploy

### Step 3: Add Environment Variables

In Railway dashboard:
1. Click on your project
2. Go to "Variables" tab
3. Add these variables:

| Variable | Value |
|----------|-------|
| STRIPE_SECRET_KEY | Your Stripe secret key |
| GMAIL_USER | Your Gmail address |
| GMAIL_APP_PASSWORD | 16-character app password |

### Step 4: Get Your Server URL

1. Go to "Settings" tab in Railway
2. Under "Domains", click "Generate Domain"
3. Copy the URL
4. Update this URL in Pool Authority app Settings tab

## API Endpoints

POST /create-checkout-session - Create Stripe payment
POST /send-invoice - Send monthly invoice email
POST /send-quote - Send quote email  
POST /send-weekly-update - Send weekly service email
POST /test-email - Test email configuration
