-- ============================================================
-- Pool Authority - Security Fixes (v2)
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- Fixes all 3 errors + 13 warnings from Security Advisor
-- + additional fixes for missing RLS, vector schema, grants
-- ============================================================

-- ============================================================
-- ERROR 1: RLS Disabled on knowledge_base
-- ============================================================
ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;

-- Service role (used by server) bypasses RLS automatically.
-- Allow authenticated users to read (for vector search via app).
CREATE POLICY "Authenticated users can read knowledge_base"
  ON public.knowledge_base
  FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================
-- ERROR 2: RLS Disabled on diagnostic_sessions
-- ============================================================
ALTER TABLE public.diagnostic_sessions ENABLE ROW LEVEL SECURITY;

-- Users can view their own sessions
CREATE POLICY "Users can view own diagnostic sessions"
  ON public.diagnostic_sessions
  FOR SELECT
  TO authenticated
  USING (tech_id = auth.uid());

-- Users can insert their own sessions
CREATE POLICY "Users can insert own diagnostic sessions"
  ON public.diagnostic_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (tech_id = auth.uid());

-- Users can update their own sessions (for ratings)
CREATE POLICY "Users can update own diagnostic sessions"
  ON public.diagnostic_sessions
  FOR UPDATE
  TO authenticated
  USING (tech_id = auth.uid());

-- ============================================================
-- ERROR 3: Security Definer View - diagnostic_stats
-- Recreate with SECURITY INVOKER (safer)
-- ============================================================
DROP VIEW IF EXISTS public.diagnostic_stats;

CREATE VIEW public.diagnostic_stats
WITH (security_invoker = true)
AS
SELECT
  COUNT(*) AS total_queries,
  COUNT(*) FILTER (WHERE has_image) AS queries_with_images,
  AVG(rating) FILTER (WHERE rating IS NOT NULL) AS avg_rating,
  COUNT(*) FILTER (WHERE resolved) AS resolved_count,
  DATE_TRUNC('day', created_at) AS query_date
FROM public.diagnostic_sessions
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY query_date DESC;

-- ============================================================
-- WARNINGS: Function Search Path Mutable (11 functions)
-- Set search_path to prevent search path injection attacks
-- ============================================================

-- Use a DO block to dynamically fix all functions
-- This finds each function's exact signature and sets search_path
DO $$
DECLARE
  func RECORD;
BEGIN
  FOR func IN
    SELECT n.nspname AS schema_name,
           p.proname AS func_name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
           p.oid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_user_role',
        'set_contract_pdf',
        'get_user_org_id',
        'get_portal_data',
        'get_contract_by_token',
        'invite_employee',
        'mark_contract_viewed',
        'create_organization_and_profile',
        'update_updated_at',
        'sign_contract',
        'match_knowledge'
      )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, extensions',
      func.schema_name, func.func_name, func.args
    );
    RAISE NOTICE 'Fixed search_path for: %.%(%)', func.schema_name, func.func_name, func.args;
  END LOOP;
END $$;

-- ============================================================
-- WARNING: Extension in Public schema (vector)
-- Move to extensions schema (Supabase best practice)
-- ============================================================
CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION vector SET SCHEMA extensions;

-- Grant usage so authenticated users and service role can use vector type
-- (Removed overly broad grant to 'public' role — anon users don't need vector ops)
GRANT USAGE ON SCHEMA extensions TO authenticated;
GRANT USAGE ON SCHEMA extensions TO service_role;

-- ============================================================
-- ADDITIONAL: RLS on tables referenced by server.js
-- These tables may have been created outside the migration files.
-- Only run these if the tables exist and RLS is not yet enabled.
-- ============================================================

-- Enable RLS on organizations (if it exists and RLS is not enabled)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organizations') THEN
    EXECUTE 'ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY';
    -- Check if policy already exists before creating
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'organizations' AND policyname = 'Users can read own org') THEN
      EXECUTE 'CREATE POLICY "Users can read own org" ON public.organizations FOR SELECT TO authenticated USING (id = (SELECT org_id FROM profiles WHERE id = auth.uid()))';
    END IF;
    RAISE NOTICE 'RLS enabled on organizations';
  END IF;
END $$;

-- Enable RLS on chemical_inventory (if it exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chemical_inventory') THEN
    EXECUTE 'ALTER TABLE public.chemical_inventory ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chemical_inventory' AND policyname = 'Users can manage own org chemicals') THEN
      EXECUTE 'CREATE POLICY "Users can manage own org chemicals" ON public.chemical_inventory FOR ALL TO authenticated USING (org_id = (SELECT org_id FROM profiles WHERE id = auth.uid()))';
    END IF;
    RAISE NOTICE 'RLS enabled on chemical_inventory';
  END IF;
END $$;

-- Enable RLS on wear_items (if it exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wear_items') THEN
    EXECUTE 'ALTER TABLE public.wear_items ENABLE ROW LEVEL SECURITY';
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'wear_items' AND policyname = 'Users can manage own org wear items') THEN
      EXECUTE 'CREATE POLICY "Users can manage own org wear items" ON public.wear_items FOR ALL TO authenticated USING (org_id = (SELECT org_id FROM profiles WHERE id = auth.uid()))';
    END IF;
    RAISE NOTICE 'RLS enabled on wear_items';
  END IF;
END $$;

-- ============================================================
-- WARNING: Leaked Password Protection Disabled
-- This is a DASHBOARD SETTING, not SQL:
--   Go to: Authentication → Settings → Enable "Leaked password protection"
-- ============================================================

-- ============================================================
-- DONE!
-- After running this SQL, also:
-- 1. Go to Authentication → Settings → Enable "Leaked password protection"
-- 2. Click "Refresh" in Security Advisor to verify all fixes
-- 3. Verify the organizations, chemical_inventory, and wear_items
--    tables have RLS enabled in the Supabase dashboard
-- ============================================================
