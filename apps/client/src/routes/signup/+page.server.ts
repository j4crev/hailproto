import {registration} from "$lib/server/registration.js";
import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";

export const load=async({setHeaders,fetch}:Pick<RequestEvent,"setHeaders"|"fetch">)=>{
  if(env.HAIL_GUI_SIGNUP!=="true")error(404,"Not found");
  const provider=env.HAIL_GUI_PROVIDER,monitorOrigin=env.ALPHA_SIGNUP_MONITOR_ORIGIN,monitorKey=env.SIGNUP_MONITOR_PUBLIC_KEY;
  if(!provider||!monitorOrigin||!monitorKey)error(503,"Signup is not configured");
  for(const value of [provider,monitorOrigin])if(new URL(value).protocol!=="https:"||new URL(value).origin!==value)error(503,"Signup is not configured");
  setHeaders({"cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff"});
  const settings=await registration(fetch);
  if(!settings?.signupAvailable)error(503,"Signup is unavailable");
  return {signupMode:settings.mode,policy:{provider,monitorOrigin,monitorKey}};
};
