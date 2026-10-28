import {env} from "$env/dynamic/private";

export async function registration(fetcher:typeof fetch=fetch):Promise<{mode:"invite"|"public";signupAvailable:boolean}|null>{
  if(env.HAIL_GUI_SIGNUP!=="true")return null;
  try{
    const origin=env.HAIL_GUI_API_ORIGIN||env.HAIL_GUI_PROVIDER;
    if(!origin)return null;
    const response=await fetcher(`${origin.replace(/\/$/,"")}/api/v1/registration`,{cache:"no-store",signal:AbortSignal.timeout(5000)});
    if(!response.ok)return null;
    const value=await response.json();
    return ["invite","public"].includes(value.mode)&&typeof value.signupAvailable==="boolean"?{mode:value.mode,signupAvailable:value.signupAvailable}:null;
  }catch{return null;}
}
