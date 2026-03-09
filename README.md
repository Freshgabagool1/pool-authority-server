# Pool Authority - Payment Server Setup

This guide will help you deploy the Stripe payment server for Pool Authority.

## Quick Start (Local Development)

### 1. Install Dependencies

```bash
cd pool-authority-server
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and add your Stripe keys (already pre-filled with your test keys).

### 3. Start the Server

```bash
npm start
```

Server will run at `http://localhost:3001`

### 4. Test It

Visit `http://localhost:3001` - you should see:
```json
{
  "status": "Pool Authority Payment Server Running",
  "version": "1.0.0",
  "stripe": "connected"
}
```

---

## Deploy to Production

### Option A: Deploy to Vercel (Recommended - Free)

1. Install Vercel CLI:
   ```bash
   npm install -g vercel
   ```

2. Deploy:
   ```bash
   cd pool-authority-server
   vercel
   ```

3. Add environment variables in Vercel Dashboard:
   - `STRIPE_SECRET_KEY` = your live key (`sk_live_...`)

4. Update `PAYMENT_SERVER_URL` in your frontend to your Vercel URL.

### Option B: Deploy to Railway (Easy)

1. Go to [railway.app](https://railway.app)
2. Connect your GitHub repo
3. Add environment variable: `STRIPE_SECRET_KEY`
4. Deploy!

### Option C: Deploy to Render (Free)

1. Go to [render.com](https://render.com)
2. Create new Web Service
3. Connect your repo
4. Add environment variable: `STRIPE_SECRET_KEY`
5. Deploy!

---

## Going Live (Real Payments)

When you're ready to accept real payments:

1. **Get Live Keys from Stripe:**
   - Go to [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)
   - Toggle from "Test" to "Live"
   - Copy your live secret key (`sk_live_...`)

2. **Update Environment Variables:**
   - In your deployment platform, change `STRIPE_SECRET_KEY` to your live key

3. **Update Frontend:**
   - Change `STRIPE_PUBLISHABLE_KEY` to your live publishable key (`pk_live_...`)
   - Change `PAYMENT_SERVER_URL` to your production server URL

4. **Set Up Webhooks (Optional but Recommended):**
   - Go to [dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks)
   - Add endpoint: `https://your-server.com/api/webhook`
   - Select events: `checkout.session.completed`, `payment_intent.payment_failed`
   - Copy webhook secret to `STRIPE_WEBHOOK_SECRET` env variable

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/api/create-checkout-session` | POST | Create Stripe Checkout session |
| `/api/create-payment-link` | POST | Create reusable payment link |
| `/api/payment-status/:sessionId` | GET | Check payment status |
| `/api/webhook` | POST | Stripe webhook handler |
| `/api/payments` | GET | List all payments |

---

## Testing Payments

Use these test card numbers:

| Card Number | Result |
|-------------|--------|
| 4242 4242 4242 4242 | Success |
| 4000 0000 0000 0002 | Declined |
| 4000 0000 0000 9995 | Insufficient funds |

Use any future expiry date and any 3-digit CVC.

---

## Support

Having issues? Check:
1. Server is running (`http://localhost:3001` returns status)
2. Environment variables are set correctly
3. Stripe API keys are valid
4. CORS is allowing your frontend origin

For Stripe-specific issues, check the [Stripe Dashboard Logs](https://dashboard.stripe.com/logs).
