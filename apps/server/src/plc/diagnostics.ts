import {isDeepStrictEqual} from "node:util";
import {assertFreshPlcReaderHealth,type IndependentPlcObserver} from "./observers.js";
import {validatePlcAudit} from "./read-evidence.js";

export interface PlcReaderDiagnostic {
  healthy:boolean;
  did?:string;
  disagreement:boolean;
  readers:{origin:string;operator?:string;healthy:boolean;operationCid?:string;error?:string}[];
}

export async function inspectPlcReaders(readers:readonly IndependentPlcObserver[],now=new Date(),did?:string):Promise<PlcReaderDiagnostic>{
  const observations=await Promise.all(readers.map(async reader=>{
    const identity={origin:reader.origin,...(reader.operator?{operator:reader.operator}:{})};
    try{
      const health=await reader.health?.();
      if(reader.origin!=="https://plc.directory")assertFreshPlcReaderHealth(health,now);
      if(!did)return {reader,result:{...identity,healthy:true}};
      const checked=await validatePlcAudit(did,await reader.audit(did));
      return {reader,checked,result:{...identity,healthy:true,operationCid:checked.operationCid}};
    }catch(error){return {reader,result:{...identity,healthy:false,
      error:error instanceof Error?error.message:"Unknown reader error"}};}
  }));
  const valid=observations.filter(observation=>observation.checked),first=valid[0]?.checked;
  const disagreement=!!did&&valid.some(observation=>!isDeepStrictEqual(observation.checked,first));
  return {healthy:observations.every(observation=>observation.result.healthy)&&!disagreement,
    ...(did?{did}:{}),disagreement,readers:observations.map(observation=>observation.result)};
}
