import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useT } from "../i18n";
import {
  AuthFailure, authEnabled, confirmSignUp, resendSignUpCode, resetPassword, sendResetCode, signIn, signUp,
  type AuthErrorCode,
} from "../lib/auth/auth";
import { notify, useApp } from "../state/app";

type Step =
  | { kind: "signin" }
  | { kind: "signup" }
  | { kind: "code"; email: string }
  | { kind: "reset"; email?: string }
  | { kind: "resetCode"; email: string };

const MIN_PASSWORD = 8;
const RESEND_COOLDOWN = 60;
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
const cleanCode = (s: string) => s.replace(/\D/g, "").slice(0, 10);

export function Auth({ mode = "signin" }: { mode?: "signin" | "signup" }) {
  const t = useT();
  const a = t.auth;
  const go = useApp((s) => s.go);
  const [step, setStep] = useState<Step>({ kind: mode });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorText = (c: AuthErrorCode) => a.errors[c];

  /** Run an auth call with a spinner and friendly errors. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); }
    catch (e) { setError(errorText(e instanceof AuthFailure ? e.code : "unknown")); }
    finally { setBusy(false); }
  };

  const done = (msg: string) => { notify(msg); go({ name: "home" }); };

  if (!authEnabled) {
    return (
      <div className="wrap stack auth">
        <h2>{a.title}</h2>
        <div className="panel"><p className="muted">{a.notConfigured}</p></div>
      </div>
    );
  }

  return (
    <div className="wrap auth">
      <div className="panel stack auth-card">
        {step.kind === "signin" && (
          <SignIn
            busy={busy}
            error={error}
            onSubmit={(email, password) =>
              run(async () => {
                try {
                  await signIn(email, password);
                  done(a.welcomeBack);
                } catch (e) {
                  // Registered but never confirmed: send a fresh code and ask for it.
                  if (e instanceof AuthFailure && e.code === "email_not_confirmed") {
                    await resendSignUpCode(email).catch(() => {});
                    setStep({ kind: "code", email });
                    return;
                  }
                  throw e;
                }
              })
            }
            onSignUp={() => { setError(null); setStep({ kind: "signup" }); }}
            onForgot={(email) => { setError(null); setStep({ kind: "reset", email }); }}
          />
        )}

        {step.kind === "signup" && (
          <SignUp
            busy={busy}
            error={error}
            onSubmit={(name, email, password) => run(async () => { await signUp(email, password, name); setStep({ kind: "code", email }); })}
            onSignIn={() => { setError(null); setStep({ kind: "signin" }); }}
          />
        )}

        {step.kind === "code" && (
          <CodeStep
            email={step.email}
            busy={busy}
            error={error}
            onSubmit={(code) => run(async () => { await confirmSignUp(step.email, code); done(a.welcome); })}
            onResend={() => run(() => resendSignUpCode(step.email))}
            onBack={() => { setError(null); setStep({ kind: "signup" }); }}
          />
        )}

        {step.kind === "reset" && (
          <Form title={a.resetTitle} lead={a.resetLead} error={error} busy={busy} submit={a.sendCode}
            onSubmit={(f) => { const email = String(f.get("email")).trim(); return run(async () => { await sendResetCode(email); setStep({ kind: "resetCode", email }); }); }}
            footer={<button type="button" className="link" onClick={() => { setError(null); setStep({ kind: "signin" }); }}>{a.backToSignIn}</button>}
          >
            <EmailField defaultValue={step.email} />
          </Form>
        )}

        {step.kind === "resetCode" && (
          <ResetCode
            email={step.email}
            busy={busy}
            error={error}
            onSubmit={(code, password) => run(async () => { await resetPassword(step.email, code, password); done(a.passwordChanged); })}
            onResend={() => run(() => sendResetCode(step.email))}
            onBack={() => { setError(null); setStep({ kind: "reset", email: step.email }); }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- pieces ---------- */

function Form(props: {
  title: string;
  lead?: ReactNode;
  error: string | null;
  busy: boolean;
  submit: string;
  onSubmit(form: FormData): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!e.currentTarget.reportValidity()) return;
        props.onSubmit(new FormData(e.currentTarget));
      }}
    >
      <div>
        <h2>{props.title}</h2>
        {props.lead && <p className="muted">{props.lead}</p>}
      </div>
      {props.children}
      {props.error && <p className="auth-error" role="alert">{props.error}</p>}
      <button className="primary" disabled={props.busy}>{props.busy ? <span className="spinner small-spinner" /> : props.submit}</button>
      {props.footer && <div className="auth-footer">{props.footer}</div>}
    </form>
  );
}

function EmailField({ defaultValue }: { defaultValue?: string }) {
  const t = useT();
  return (
    <label className="field">
      {t.auth.email}
      <input name="email" type="email" required autoComplete="email" inputMode="email" defaultValue={defaultValue} placeholder="you@example.com" />
    </label>
  );
}

function PasswordField({ name = "password", label, autoComplete }: { name?: string; label: string; autoComplete: string }) {
  const [shown, setShown] = useState(false);
  const t = useT();
  return (
    <label className="field">
      {label}
      <span className="password">
        <input name={name} type={shown ? "text" : "password"} required minLength={autoComplete === "new-password" ? MIN_PASSWORD : undefined} autoComplete={autoComplete} />
        <button type="button" className="small ghost" onClick={() => setShown((s) => !s)} aria-pressed={shown}>{shown ? t.auth.hide : t.auth.show}</button>
      </span>
    </label>
  );
}

function SignIn({ busy, error, onSubmit, onSignUp, onForgot }: { busy: boolean; error: string | null; onSubmit(email: string, password: string): void; onSignUp(): void; onForgot(email: string): void }) {
  const a = useT().auth;
  const [email, setEmail] = useState("");
  return (
    <Form title={a.signInTitle} error={error} busy={busy} submit={a.signIn}
      onSubmit={(f) => onSubmit(String(f.get("email")).trim(), String(f.get("password")))}
      footer={<>
        <button type="button" className="link" onClick={() => onForgot(email)}>{a.forgot}</button>
        <span className="muted">{a.noAccount} <button type="button" className="link" onClick={onSignUp}>{a.signUp}</button></span>
      </>}
    >
      <label className="field">
        {a.email}
        <input name="email" type="email" required autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <PasswordField label={a.password} autoComplete="current-password" />
    </Form>
  );
}

function SignUp({ busy, error, onSubmit, onSignIn }: { busy: boolean; error: string | null; onSubmit(name: string, email: string, password: string): void; onSignIn(): void }) {
  const a = useT().auth;
  const [mismatch, setMismatch] = useState(false);
  return (
    <Form title={a.signUpTitle} lead={a.signUpLead} error={mismatch ? a.mismatch : error} busy={busy} submit={a.signUp}
      onSubmit={(f) => {
        const password = String(f.get("password"));
        if (password !== String(f.get("password2"))) { setMismatch(true); return; }
        setMismatch(false);
        const email = String(f.get("email")).trim();
        if (!isEmail(email)) return;
        onSubmit(String(f.get("name")).trim(), email, password);
      }}
      footer={<span className="muted">{a.haveAccount} <button type="button" className="link" onClick={onSignIn}>{a.signIn}</button></span>}
    >
      <label className="field">
        {a.name}
        <input name="name" required maxLength={30} autoComplete="nickname" />
      </label>
      <EmailField />
      <PasswordField label={a.passwordNew(MIN_PASSWORD)} autoComplete="new-password" />
      <PasswordField name="password2" label={a.passwordRepeat} autoComplete="new-password" />
    </Form>
  );
}

/** Resend link with a cooldown so people don't hit the email rate limit. */
function Resend({ onResend }: { onResend(): void }) {
  const a = useT().auth;
  const [left, setLeft] = useState(RESEND_COOLDOWN);
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);
  return left > 0
    ? <span className="muted">{a.resendIn(left)}</span>
    : <button type="button" className="link" onClick={() => { setLeft(RESEND_COOLDOWN); onResend(); }}>{a.resend}</button>;
}

function CodeField() {
  const a = useT().auth;
  const [code, setCode] = useState("");
  return (
    <label className="field">
      {a.code}
      <input
        name="code" className="code-input" required minLength={6} inputMode="numeric" autoComplete="one-time-code" autoFocus
        placeholder="123456" value={code} onChange={(e) => setCode(cleanCode(e.target.value))}
      />
    </label>
  );
}

function CodeStep({ email, busy, error, onSubmit, onResend, onBack }: { email: string; busy: boolean; error: string | null; onSubmit(code: string): void; onResend(): void; onBack(): void }) {
  const a = useT().auth;
  return (
    <Form title={a.codeTitle} lead={a.codeLead(email)} error={error} busy={busy} submit={a.confirm}
      onSubmit={(f) => onSubmit(cleanCode(String(f.get("code"))))}
      footer={<>
        <Resend onResend={onResend} />
        <button type="button" className="link" onClick={onBack}>{a.changeEmail}</button>
      </>}
    >
      <CodeField />
      <p className="muted fine">{a.spamHint}</p>
    </Form>
  );
}

function ResetCode({ email, busy, error, onSubmit, onResend, onBack }: { email: string; busy: boolean; error: string | null; onSubmit(code: string, password: string): void; onResend(): void; onBack(): void }) {
  const a = useT().auth;
  const [mismatch, setMismatch] = useState(false);
  return (
    <Form title={a.newPasswordTitle} lead={a.codeLead(email)} error={mismatch ? a.mismatch : error} busy={busy} submit={a.savePassword}
      onSubmit={(f) => {
        const password = String(f.get("password"));
        if (password !== String(f.get("password2"))) { setMismatch(true); return; }
        setMismatch(false);
        onSubmit(cleanCode(String(f.get("code"))), password);
      }}
      footer={<>
        <Resend onResend={onResend} />
        <button type="button" className="link" onClick={onBack}>{a.changeEmail}</button>
      </>}
    >
      <CodeField />
      <PasswordField label={a.passwordNew(MIN_PASSWORD)} autoComplete="new-password" />
      <PasswordField name="password2" label={a.passwordRepeat} autoComplete="new-password" />
    </Form>
  );
}
