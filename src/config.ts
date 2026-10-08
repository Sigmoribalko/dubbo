/*
 * Public project settings. The Supabase "anon" key is meant to be public (it's used in the
 * browser); access is controlled by Supabase itself. Can be overridden at build time with
 * VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
 */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
