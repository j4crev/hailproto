import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [tailwindcss(), sveltekit()],ssr:{external:["@atproto/common","@atproto/crypto","@did-plc/lib","@hailproto/codec","@ipld/dag-cbor","multiformats"]},server:{proxy:{"/api/v1/auth":{
  target:process.env.HAIL_GUI_API_ORIGIN||process.env.HAIL_GUI_PROVIDER||"https://haili.app",changeOrigin:false,secure:true,
},"/api/v1/operator":{
  target:process.env.HAIL_GUI_API_ORIGIN||process.env.HAIL_GUI_PROVIDER||"https://haili.app",changeOrigin:false,secure:true,
}}} });
