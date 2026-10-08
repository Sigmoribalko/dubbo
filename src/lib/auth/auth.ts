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

interface AuthState {
  ready: boolean;
  user: User | null;
}

export const useAuth = create<AuthState>(() => ({ ready: !authEnabled, user: null }));

export function initAuth() {
  if (!authEnabled) return;
  sb().auth.getSession().then(({ data }) => useAuth.setState({ ready: true, user: data.session?.user ?? null }));
  sb().auth.onAuthStateChange((_event, session: Session | null) => useAuth.setState({ ready: true, user: session?.user ?? null }));
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
