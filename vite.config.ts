import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/*
 * Content-Security-Policy for the built page. GitHub Pages can't send headers, so it goes in a
 * <meta>. Runs after the single-file inlining so it can hash the one inline app script: any
 * script injected later (XSS) has no matching hash and the browser refuses to run it.
 */
function csp(): Plugin {
  let supabase = "";
  const sha256 = async (s: string) =>
    btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))));
  return {
    name: "dubparty-csp",
    apply: "build",
    enforce: "post",
    configResolved(c) {
      const url = String(c.env.VITE_SUPABASE_URL ?? "");
      supabase = url ? new URL(url).host : "";
    },
    async generateBundle(_, bundle) {
      const page = bundle["index.html"];
      if (!page || page.type !== "asset") return;
      const html = String(page.source);
      const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)];
      const hashes = await Promise.all(scripts.map(async (m) => `'sha256-${await sha256(m[1])}'`));
      const policy = [
        "default-src 'self'",
        // blob: is the pitch-shift AudioWorklet, built from a string at runtime.
        `script-src 'self' ${hashes.join(" ")} blob:`,
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        `connect-src 'self' https://0.peerjs.com wss://0.peerjs.com${supabase ? ` https://${supabase} wss://${supabase}` : ""}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        // DOM XSS: the browser refuses raw strings in innerHTML & co.
        "require-trusted-types-for 'script'",
        "trusted-types 'none'",
        "upgrade-insecure-requests",
      ].join("; ");
      const meta =
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />\n` +
        `    <meta name="referrer" content="strict-origin-when-cross-origin" />\n    `;
      page.source = html.replace(/<meta name="viewport"/, (m) => meta + m);
    },
  };
}

// `npm run build` produces a single self-contained dist/index.html that opens
// straight from disk (file://) — handy for sharing the game as one file.
export default defineConfig({
  plugins: [react(), viteSingleFile(), csp()],
  build: { target: "es2022", assetsInlineLimit: Infinity },
});
