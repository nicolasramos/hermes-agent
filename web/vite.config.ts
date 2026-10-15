import { defineConfig, type Plugin } from "vite";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";

/** React Compiler preset scoped to modules that can actually contain
 *  components/hooks (JSX syntax or a react-ish import). The preset's default
 *  code filter matches any PascalCase/use* declaration — effectively every TS
 *  module — which made the babel pass parse the whole codebase. */
function compilerPreset() {
  const preset = reactCompilerPreset();
  preset.rolldown.filter.code = /\/>|<\/|from\s*['"][^'"]*react/;
  return preset;
}
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

const BACKEND = process.env.HERMES_DASHBOARD_URL ?? "http://127.0.0.1:9119";

/**
 * In production the Python `hermes dashboard` server injects a one-shot
 * session token into `index.html` (see `hermes_cli/web_server.py`). The
 * Vite dev server serves its own `index.html`, so unless we forward that
 * token, every protected `/api/*` call 401s.
 *
 * This plugin fetches the running dashboard's `index.html` on each dev page
 * load, scrapes the `window.__HERMES_SESSION_TOKEN__` assignment, and
 * re-injects it into the dev HTML. No-op in production builds.
 */
function hermesDevToken(): Plugin {
  const TOKEN_RE = /window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;
  const EMBEDDED_RE =
    /window\.__HERMES_DASHBOARD_EMBEDDED_CHAT__\s*=\s*(true|false)/;

  return {
    name: "hermes:dev-session-token",
    apply: "serve",
    async transformIndexHtml() {
      try {
        const res = await fetch(BACKEND, { headers: { accept: "text/html" } });
        const html = await res.text();
        const match = html.match(TOKEN_RE);
        if (!match) {
          console.warn(
            `[hermes] Could not find session token in ${BACKEND} — ` +
              `is \`hermes dashboard\` running? /api calls will 401.`,
          );
          return;
        }
        const embeddedMatch = html.match(EMBEDDED_RE);
        const embeddedJs = embeddedMatch ? embeddedMatch[1] : "true";
        return [
          {
            tag: "script",
            injectTo: "head",
            children:
              `window.__HERMES_SESSION_TOKEN__="${match[1]}";` +
              `window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=${embeddedJs};`,
          },
        ];
      } catch (err) {
        console.warn(
          `[hermes] Dashboard at ${BACKEND} unreachable — ` +
            `start it with \`hermes dashboard\` or set HERMES_DASHBOARD_URL. ` +
            `(${(err as Error).message})`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [compilerPreset()] }),
    tailwindcss(),
    hermesDevToken(),
    VitePWA({
      // Static web-app manifest is authored in public/manifest.json and
      // served from /manifest.json; the plugin owns the precaching
      // service-worker only (no manifest generation to keep a verifiable
      // static file).
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,png,ico}"],
        // The built shell must never be served for a navigation: the dashboard
        // server injects __HERMES_SESSION_TOKEN__ into index.html on every real
        // navigation (`Cache-Control: no-store`), and a precached shell carries
        // no token, so serving it leaves every /api/* call at 401. Keep
        // index.html out of the precache and let navigations reach the network.
        globIgnores: ["**/index.html"],
        // vite-plugin-pwa injects `navigateFallback: "index.html"` in its own
        // defaults when the option is absent. workbox resolves that fallback
        // eagerly through createHandlerBoundToURL(), which throws
        // `non-precached-url` for a URL that is not in the manifest — and the
        // throw kills the whole service-worker script. Explicit undefined is
        // what neutralises the default; omitting the key is not enough.
        navigateFallback: undefined,
        runtimeCaching: [
          {
            // The only document handler: network first, which is where the
            // server injects the token. When the network fails (or times out)
            // and nothing is cached, PrecacheFallbackPlugin's handlerDidError
            // serves the precached static offline page — never a token-less
            // shell, and never the browser's own error page.
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              networkTimeoutSeconds: 3,
              cacheName: "navigation-cache",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24, // 1 day
              },
              // workbox's default for this plugin is statuses: [0] (opaque
              // responses only). Pinning that default states the intent: the
              // authenticated document is NEVER persisted. Caching 200s here
              // would put a document carrying __HERMES_SESSION_TOKEN__ in Cache
              // Storage for a day (the server's Cache-Control: no-store is not
              // consulted — the plugin decides on status alone), and an offline
              // repeat navigation would then be answered with that stale shell
              // instead of the offline page.
              cacheableResponse: {
                statuses: [0],
              },
              precacheFallback: {
                fallbackURL: "offline.html",
              },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@hermes/shared": path.resolve(__dirname, "../apps/shared/src"),
    },
    // When @nous-research/ui is symlinked via `file:../../design-language`,
    // Node's module resolution would pick up shared deps from
    // design-language/node_modules/*, giving us two copies + breaking
    // hooks (useRef-of-null), webgl contexts, etc. Force everything that
    // exists in BOTH places to use the dashboard's copy.
    //
    // Don't list packages here that only exist in the DS (nanostores,
    // @nanostores/react) — Vite dedupe errors out when it can't find
    // them at the project root.
    dedupe: [
      "react",
      "react-dom",
      "@react-three/fiber",
      "@observablehq/plot",
      "three",
      "leva",
      "gsap",
    ],
  },
  build: {
    outDir: "../hermes_cli/web_dist",
    emptyOutDir: true,
    // Shell stays a bit over Vite's 500 kB default after vendor splits;
    // page/xterm chunks load on demand. Keep a modest ceiling so a true
    // regression still warns.
    chunkSizeWarningLimit: 600,
    // Split heavy vendors so the first dashboard paint does not download
    // xterm/three/plot/etc. until a route actually needs them. Lazy page
    // imports in App.tsx create the route boundaries; these groups keep
    // shared node_modules out of every page chunk.
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20_000,
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router)([\\/]|$)/,
            },
            {
              name: "xterm",
              test: /node_modules[\\/]@xterm[\\/]/,
            },
            {
              name: "three",
              test: /node_modules[\\/](three|@react-three)([\\/]|$)/,
            },
            {
              name: "plot",
              test: /node_modules[\\/]@observablehq[\\/]plot([\\/]|$)/,
            },
            {
              name: "motion",
              test: /node_modules[\\/](motion|framer-motion)([\\/]|$)/,
            },
            {
              name: "ui",
              test: /node_modules[\\/]@nous-research[\\/]ui([\\/]|$)/,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: BACKEND,
        ws: true,
      },
      // Same host as `hermes dashboard` must serve these; Vite has no
      // dashboard-plugins/* files, so without this, plugin scripts 404
      // or receive index.html in dev.
      "/dashboard-plugins": BACKEND,
    },
  },
});
