import {isIP} from "node:net";

export const CLIENT_ADDRESS_HEADER="X-Hail-Trusted-Client-IP";

export function clientAddress(request:Request):string{
  const value=request.headers.get(CLIENT_ADDRESS_HEADER);
  return value&&isIP(value)?value:"unidentified";
}

export class FixedWindowRateLimit {
  private readonly buckets=new Map<string,{started:number;count:number}>();
  constructor(private readonly maximumBuckets=4096){}

  take(key:string,ceiling:number,now=Date.now()):number|null{
    let bucket=this.buckets.get(key);
    if(!bucket||now-bucket.started>=60_000){
      if(!bucket&&this.buckets.size>=this.maximumBuckets)this.buckets.delete(this.buckets.keys().next().value!);
      bucket={started:now,count:0};this.buckets.set(key,bucket);
    }
    bucket.count++;
    return bucket.count<=ceiling?null:Math.max(1,Math.ceil((60_000-(now-bucket.started))/1000));
  }
}
