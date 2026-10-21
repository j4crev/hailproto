import {AsyncLocalStorage} from "node:async_hooks";
import type {SQL} from "bun";

type Generations=Record<string,number>;
const admitted=new AsyncLocalStorage<Generations|undefined>();
export function withServingGeneration<T>(account:string,generation:number,operation:()=>T|Promise<T>) {
  return admitted.run({...admitted.getStore(),[account]:generation},operation);
}
export async function withFreshServingGenerations<T>(sql:SQL,operation:()=>T|Promise<T>) {
  // ponytail: one provider-wide admission snapshot, O(accounts); capture per-DID at entry points if throughput matters.
  return admitted.run(undefined,async()=>{
    const rows=await sql<{account_id:string;generation:string|number}[]>`SELECT account_id,generation FROM account_serving_generations`;
    return admitted.run(Object.fromEntries(rows.map(row=>[row.account_id,Number(row.generation)])),operation);
  });
}
export function materializedServingGeneration(account:string,generation:number,reserved="") {
  const context=admitted.getStore();if(context){context[account]=generation;delete context[reserved];}
}
export function releasedServingReservation(reserved:string) {const context=admitted.getStore();if(context)delete context[reserved];}

// Native transaction-local settings reach the existing shared DID write guard.
// Reads recheck admission too, so a stale job cannot sign from returned keys.
export function generationBoundSql(sql:SQL):SQL {
  const prepare=async(tx:SQL,context:Generations)=>{
    await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify(context)},true)`;
    await tx`SELECT hail_check_generation_snapshot()`;
  };
  return new Proxy(sql,{
    apply(target,thisArg,args){
      const context=admitted.getStore();if(!context)return Reflect.apply(target,thisArg,args);
      return target.begin(async tx=>{await prepare(tx,context);return Reflect.apply(tx,tx,args);});
    },
    get(target,key){
      if(key==="begin")return (callback:(tx:SQL)=>Promise<unknown>)=>{
        const context=admitted.getStore();return target.begin(async tx=>{if(context)await prepare(tx,context);return callback(tx);});
      };
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    },
  });
}
