import type {PortableBundle} from './core.js';
export type Recovery = {version:1;revision:number;baseRevision:number;bundle:PortableBundle};
/** Serialized local CAS. No last-writer-wins fallback on browsers without Web Locks. */
export class BuilderStorage {
  constructor(private storage:Pick<Storage,'getItem'|'setItem'>,private locks:Pick<LockManager,'request'>,private key:string){}
  read():Recovery|null {
    const raw=this.storage.getItem(this.key);if(!raw)return null;
    if(raw.length>1050000)throw new Error('Recovery data exceeds the draft limit.');
    const value=JSON.parse(raw) as Recovery;
    if(value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||!Number.isSafeInteger(value.baseRevision)||value.baseRevision<0)throw new Error('Unsupported recovery record');
    return value;
  }
  async save(bundle:PortableBundle,baseRevision:number,expected:number):Promise<Recovery>{
    return this.locks.request(this.key,()=>{
      const current=this.read();if((current?.revision??0)!==expected)throw new Error('Another tab changed this local draft. Export your work before reloading.');
      const next:Recovery={version:1,revision:expected+1,baseRevision,bundle};
      const raw=JSON.stringify(next);if(raw.length>1050000)throw new Error('Recovery data exceeds the draft limit.');
      this.storage.setItem(this.key,raw);return next;
    });
  }
}
