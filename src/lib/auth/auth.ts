import { createClient, type AuthError, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";
import { create } from "zustand";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../../config";

/*
 * Accounts: email + password, confirmed with a one-time code sent by email (Supabase Auth).
 * Password reset works the same way: a code by email, then a new password.
 */

export const authEnabled = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;
function sb(): SupabaseClient {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

/** Row of `public.profiles` (see supabase/migrations). */
export interface Profile {
  id: string;
  name: string | null;
  plan: string;
  dubs_used: number;
  /** null = unlimited. */
  dubs_limit: number | null;
}

interface AuthState {
  ready: boolean;
  user: User | null;
  profile: Profile | null;
}

export const useAuth = create<AuthState>(() => ({ ready: !authEnabled, user: null, profile: null }));

export async function refreshProfile() {
  const user = useAuth.getState().user;
  if (!authEnabled || !user) { useAuth.setState({ profile: null }); return; }
  const { data } = await sb().from("profiles").select("id, name, plan, dubs_used, dubs_limit").eq("id", user.id).maybeSingle();
  useAuth.setState({ profile: (data as Profile | null) ?? null });
}

export function initAuth() {
  if (!authEnabled) return;
  const apply = (session: Session | null) => {
    const user = session?.user ?? null;
    const changed = user?.id !== useAuth.getState().user?.id;
    useAuth.setState({ ready: true, user });
    if (changed) refreshProfile();
  };
  sb().auth.getSession().then(({ data }) => apply(data.session));
  sb().auth.onAuthStateChange((_event, session) => apply(session));
}

/** Out of dubs on the current plan? (Guests and accounts without a limit never are.) */
export function dubLimitReached(): boolean {
  const p = useAuth.getState().profile;
  return !!p && p.dubs_limit != null && p.dubs_used >= p.dubs_limit;
}

/**
 * Count one dub on the server (atomic, can't be faked from the page). Returns false when the
 * plan's limit is reached. Guests and an unreachable server don't block play.
 */
export async function countDub(scene: string): Promise<boolean> {
  if (!authEnabled || !useAuth.getState().user) return true;
  const { data, error } = await sb().rpc("use_dub", { scene_title: scene });
  if (error) return true;
  const res = data as { allowed: boolean; used: number; limit: number | null };
  const p = useAuth.getState().profile;
  if (p) useAuth.setState({ profile: { ...p, dubs_used: res.used, dubs_limit: res.limit } });
  return res.allowed;
}

export const displayName = (u: User | null) => (u?.user_metadata?.name as string | undefined) || u?.email?.split("@")[0] || "";

export type AuthErrorCode = "invalid_credentials" | "email_not_confirmed" | "user_exists" | "weak_password" | "bad_code" | "rate_limit" | "network" | "unknown";

function codeOf(e: AuthError | Error | null | undefined): AuthErrorCode {
  if (!e) return "unknown";
  const code = (e as AuthError).code ?? "";
  const msg = e.message.toLowerCase();
  if (code === "invalid_credentials" || msg.includes("invalid login")) return "invalid_credentials";
  if (code === "email_not_confirmed" || msg.includes("not confirmed")) return "email_not_confirmed";
  if (code === "user_already_exists" || code === "email_exists" || msg.includes("already registered")) return "user_exists";
  if (code === "weak_password" || msg.includes("password should")) return "weak_password";
  if (code === "otp_expired" || msg.includes("token has expired") || msg.includes("invalid") && msg.includes("otp")) return "bad_code";
  if (code.includes("rate_limit") || msg.includes("rate limit") || (e as AuthError).status === 429) return "rate_limit";
  if (msg.includes("fetch") || msg.includes("network")) return "network";
  return "unknown";
}

export class AuthFailure extends Error {
  constructor(public code: AuthErrorCode, cause?: unknown) {
    super(code);
    this.cause = cause;
  }
}

const fail = (e: AuthError | Error | null) => { throw new AuthFailure(codeOf(e), e); };

/** Create the account; Supabase emails a confirmation code. */
export async function signUp(email: string, password: string, name: string) {
  const { data, error } = await sb().auth.signUp({ email, password, options: { data: { name } } });
  if (error) fail(error);
  // An existing confirmed email comes back without identities (Supabase hides account existence).
  if (data.user && data.user.identities?.length === 0) throw new AuthFailure("user_exists");
}

export async function confirmSignUp(email: string, code: string) {
  const { error } = await sb().auth.verifyOtp({ email, token: code, type: "signup" });
  if (error) fail(error);
}

export async function resendSignUpCode(email: string) {
  const { error } = await sb().auth.resend({ type: "signup", email });
  if (error) fail(error);
}

export async function signIn(email: string, password: string) {
  const { error } = await sb().auth.signInWithPassword({ email, password });
  if (error) fail(error);
}

/** Step 1 of a reset: email a recovery code. */
export async function sendResetCode(email: string) {
  const { error } = await sb().auth.resetPasswordForEmail(email);
  if (error) fail(error);
}

/** Step 2: the code signs you in, then the new password is saved. */
export async function resetPassword(email: string, code: string, password: string) {
  const v = await sb().auth.verifyOtp({ email, token: code, type: "recovery" });
  if (v.error) fail(v.error);
  const u = await sb().auth.updateUser({ password });
  if (u.error) fail(u.error);
}

export async function signOut() {
  await sb().auth.signOut();
}
