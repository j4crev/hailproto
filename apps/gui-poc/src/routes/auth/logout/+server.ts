import {error,redirect} from "@sveltejs/kit";
import {API_ORIGIN,ORIGIN} from "$lib/server/canary.js";

export async function POST({cookies}){
  const token=cookies.get("hail_session");
  if(token){
    let response:Response;try{response=await fetch(`${API_ORIGIN}/api/v1/auth/logout`,{method:"POST",headers:{Cookie:`hail_session=${token}`,Origin:ORIGIN}});}
    catch{error(502,"Provider logout unavailable");}
    if(!response.ok)error(502,"Provider logout failed");
  }
  cookies.delete("hail_session",{path:"/"});
  redirect(303,"/");
}
