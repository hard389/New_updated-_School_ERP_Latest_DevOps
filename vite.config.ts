import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifestFilename: "manifest.webmanifest",
      devOptions: {
        enabled: true,
      },
      workbox: {
        // Build crash hone se bachane ke liye Workbox limit 2MB se barha kar 5MB kar di hai
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: "EduTrack",
        short_name: "EduTrack",
        description: "School Managemnt System Powered By Ali Tahir",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/logo.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/logo.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("firebase")) {
              return "firebase"; // Firebase bundle ko alag file mein split kar dega
            }
            return "vendor";
          }
        },
      },
    },
  },
});
