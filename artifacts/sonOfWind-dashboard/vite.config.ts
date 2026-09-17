import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const rawPort = process.env.PORT ?? "5174";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    hmr: { overlay: false },
    fs: {
      strict: true,
    },
    // Same-origin `/api/*` → Flask. LAN UI (192.168.x.x:5174) must proxy SSE too —
    // the browser cannot EventSource 127.0.0.1 from a LAN page.
    proxy: {
      "/api/md/stream": {
        target: process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:5000",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Accept", "text/event-stream");
            proxyReq.setHeader("Cache-Control", "no-cache");
          });
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            proxyRes.headers["cache-control"] = "no-cache, no-store, no-transform";
            proxyRes.headers["x-accel-buffering"] = "no";
            proxyRes.headers["connection"] = "keep-alive";
            try {
              (res.socket as { setNoDelay?: (v: boolean) => void } | null)?.setNoDelay?.(true);
            } catch {
              /* ignore */
            }
            try {
              (res as { flushHeaders?: () => void }).flushHeaders?.();
            } catch {
              /* ignore */
            }
            proxyRes.on("data", () => {
              try {
                (res as { flush?: () => void }).flush?.();
              } catch {
                /* ignore */
              }
            });
          });
        },
      },
      "/api": {
        target: process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:5000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
