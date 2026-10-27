import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load:PageServerLoad=({setHeaders})=>{
  if(env.HAIL_GUI_SIGNUP!=="true")error(404,"Not found");
  const provider=env.HAIL_GUI_PROVIDER,monitorOrigin=env.ALPHA_SIGNUP_MONITOR_ORIGIN,monitorKey=env.SIGNUP_MONITOR_PUBLIC_KEY;
  if(!provider||!monitorOrigin||!monitorKey)error(503,"Signup is not configured");
  for(const value of [provider,monitorOrigin])if(new URL(value).protocol!=="https:"||new URL(value).origin!==value)error(503,"Signup is not configured");
  setHeaders({"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"});
  return {policy:{provider,monitorOrigin,monitorKey}};
};
