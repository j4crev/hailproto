import {isConfigured,canaryAccount} from "$lib/server/canary.js";
export async function load({cookies,url}){
  if(!isConfigured(cookies))return {signedIn:false,address:null};
  const {account}=await canaryAccount(cookies,url);return {signedIn:true,address:account.address};
}
