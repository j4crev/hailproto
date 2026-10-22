import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [sveltekit()],server:{proxy:{"/api/v1/auth":{
  target:process.env.HAIL_GUI_API_ORIGIN||process.env.HAIL_GUI_PROVIDER||"https://haili.app",changeOrigin:false,secure:true,
}}} });
