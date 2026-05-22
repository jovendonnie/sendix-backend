import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-04-22.dahlia',
})

export const PLANS = {
  pro: {
    name: 'Pro',
    priceId: process.env.STRIPE_PRICE_PRO!,
    emails: 50000,
    apiKeys: -1,
    domains: 3,
  },
  agency: {
    name: 'Agency',
    priceId: process.env.STRIPE_PRICE_AGENCY!,
    emails: 200000,
    apiKeys: -1,
    domains: 10,
  },
  free: {
    name: 'Free',
    priceId: null,
    emails: 3000,
    apiKeys: 1,
    domains: 1,
  },
}

/*
  Run this SQL manually in Supabase SQL Editor:
  
  ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS plan text DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz;
*/
