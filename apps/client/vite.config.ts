import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({mode}) => {
  const env = {...loadEnv(mode, process.cwd(), "HAIL_WEB_CLIENT_"), ...process.env};
  const target = env.HAIL_WEB_CLIENT_API_ORIGIN || env.HAIL_WEB_CLIENT_PROVIDER;
  return {
    plugins: [tailwindcss(), sveltekit()],
    ssr: {external: ["@atproto/common", "@atproto/crypto", "@did-plc/lib", "@hailproto/codec", "@ipld/dag-cbor", "multiformats"]},
    server: {proxy: target ? {
      "/api/v1/auth": {target, changeOrigin: false, secure: true},
      "/api/v1/operator": {target, changeOrigin: false, secure: true},
    } : undefined},
  };
});
