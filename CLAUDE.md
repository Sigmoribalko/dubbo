# DubParty — project notes for Claude

Online party game: friends (or random players) dub movie scenes together, each on their own phone.
Live: https://dubparty.ru (GitHub Pages, repo Sigmoribalko/dubparty). Owner talks in Russian, wants short, practical answers.

## Stack
- Vite + React 19 + TypeScript + zustand. `npm run dev` (port 5173), `npm run build` → single-file `dist/index.html` (vite-plugin-singlefile).
- Deploy: push to `main` → GitHub Actions `.github/workflows/pages.yml` builds and publishes. If the deploy step fails with
  "No artifacts named github-pages", just `gh run rerun <id>` (transient GitHub issue).
- Custom domain dubparty.ru (reg.ru DNS: 4× A @ → 185.199.108–111.153, CNAME www → sigmoribalko.github.io). `public/CNAME`.
  HTTPS certificate was still pending on 2026-10-09; when `gh api repos/Sigmoribalko/dubparty/pages --jq .https_certificate.state`
  says approved, run `gh api -X PUT repos/Sigmoribalko/dubparty/pages -F https_enforced=true`.

## Game flow (owner's spec)
lobby (host picks/imports pack + scene, invites, everyone downloads) → host "Начать: выбор ролей" → casting (pick role,
"Перевыбрать", "Перемешать роли"; public rooms deal at random) → host "Начать запись" when everyone has a role →
recording line by line ("Реплика N из M": listen original, record, listen back, re-record, Далее / ← Назад, last = Сдать)
→ waiting screen (who submitted, lines left for others) → everyone submitted → show autoplays → vote best voice
(not yourself) → download video / host "К выбору сцены" / leave.
- Line takes live in `game.lineTakes`; on submit `src/lib/audio/compose.ts` joins them into one WAV voice track, so
  networking/mixing/export still handle one recording per role. Progress is sent as `{t:"lines", n}`.

## Drops and bad connections (`src/net/room.ts`)
- Each browser has a secret player key (localStorage `dubl-player-key`, sent only to the host in `hello`). A dropped
  player who comes back with the same key gets their seat, role and votes back (only if that seat is offline).
- Before the game a dropped seat is held 60 s, during the game it stays (offline). The show auto-starts only when
  every cast player submitted; if someone dropped without submitting the host can start it anyway.
- Guests auto-reconnect to the host for 90 s ("Переподключаюсь…" banner) and resend their own take on return.
- The host's room is saved in localStorage (`dubl-hosted`, own take blob in IndexedDB) for 20 min; Home offers
  "Вернуться в комнату" and `resumeRoom()` reopens the same room id. Leaving on purpose sends `bye` to guests.

## Code map
- `src/net/room.ts` — online rooms over WebRTC (PeerJS public signalling). Host is authoritative; guests download the scene;
  public rooms advertise on `dubbo-v1-pub-<0..39>` (found by `src/net/finder.ts`); capacity = number of roles; random role dealing.
- `src/state/online.ts` — builds the per-device `Game` for a round, syncs received takes, drives navigation by room phase.
- `src/lib/audio/` — Web Audio engine (`VideoMixer`, buses tied to settings), voice effects + pitch-shift AudioWorklet, mic,
  video export, loudness envelopes. Dubbed character's voice is removed from the video soundtrack (centre-cancel during
  their lines, or full mute when the pack has a backing track).
- `src/views/` — Home (two cards), Packs, Editor, Online (entry/finder/lobby), Record (voice-track lanes), Screening (votes),
  Auth (email + password + emailed code), Profile (dubs count, best-voice wins).
- `src/i18n/{ru,en}.ts` — every UI string. Russian is the default language.
- Packs and media live in the browser (IndexedDB, `src/lib/store.ts`); only the room host needs the pack.

## Accounts (Supabase)
- Project `https://xkypecdassssdrogfker.supabase.co`, publishable key in repo variables SUPABASE_URL / SUPABASE_ANON_KEY
  (CI injects them as VITE_SUPABASE_*; locally use `.env.local`, git-ignored). Never use or ask for the secret key.
- SQL already applied: `supabase/migrations/001_profiles_and_dubs.sql` (profiles, dubs, `use_dub` RPC with optional
  `dubs_limit`) and `002_best_voice_wins.sql` (`profiles.wins`, `record_win` once per room round).
- `003_hardening.sql` (record_win limits: 1 win / 2 min, 30 / day; name length cap; write grants revoked) must be
  run by the owner in the SQL Editor — not applied automatically.
- Email codes sent via Resend SMTP from noreply@mail.dubparty.ru (domain mail.dubparty.ru set up in Resend).
- Dub limits are not enforced yet (`dubs_limit` null = unlimited); guests can play without an account.

## Security
- Peers are untrusted (public rooms = strangers). `src/net/link.ts` caps file size, enforces in-order frames, keeps only
  audio/video/image blob types. `src/net/room.ts` host accepts a take only for the sender's own role, effects only from
  the role owner, votes/picks only for real roles; guests accept only media keys the scene uses.
- Build injects a CSP `<meta>` with the hash of the inlined app script (`vite.config.ts`, plugin `dubparty-csp`).
  New external hosts (APIs, CDNs) must be added to its `connect-src`/`script-src` or they will be blocked.

## Preferences learned
- Online-only game, one format (whole group dubs a scene, vote for best voice). No local single-device mode, no team mode.
- No emoji in the UI. Keep design non-"AI-looking"; no demo track on the home page.
- Test on phone layouts (bottom nav, sheets); avoid horizontal overflow.
