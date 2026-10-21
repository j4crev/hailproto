import {toDiagnosticJson} from "@hailproto/codec";
import {AccountApiClient} from "./account-api.js";
import {privateFile} from "./grant-revocation.js";

async function definition(path:string):Promise<Record<string,unknown>>{
  const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,16_384)));
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Sender Profile definition must be an object");
  const record=value as Record<string,unknown>;
  if(Object.keys(record).some(key=>!["display_name","description","offers_uncategorized","categories"].includes(key))||
    typeof record.display_name!=="string"||record.description!==undefined&&typeof record.description!=="string"||
    typeof record.offers_uncategorized!=="boolean"||!Array.isArray(record.categories)||record.categories.some(value=>{
      if(!value||typeof value!=="object"||Array.isArray(value))return true;const category=value as Record<string,unknown>;
      return Object.keys(category).some(key=>!["id","label","description"].includes(key))||typeof category.id!=="string"||
        typeof category.label!=="string"||category.description!==undefined&&typeof category.description!=="string";
    }))throw new Error("Sender Profile definition has an invalid shape");
  return record;
}

function result(profile:Awaited<ReturnType<AccountApiClient["profile"]>>){
  return {revision:profile.payload.revision,digest:profile.digest,profile:toDiagnosticJson("hail.sender-profile",profile.payload)};
}

export async function showProfile(client:AccountApiClient){return result(await client.profile());}

export async function createProfile(client:AccountApiClient,path:string){return result(await client.saveProfile(await definition(path),0));}

export async function updateProfile(client:AccountApiClient,path:string){
  const current=await client.profile();return result(await client.saveProfile(await definition(path),current.payload.revision));
}
