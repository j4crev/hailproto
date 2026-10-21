import { isDeepStrictEqual } from "node:util";
import { encode as encodeDagCbor } from "@ipld/dag-cbor";
import { decodeDeterministic, encodeBase64Url, type HailValue } from "@hailproto/codec";
import { def, formatDidDoc, type ExportedOp } from "@did-plc/lib";
import type { SQL } from "bun";
import type { AppConfig } from "../config.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";
import { PLC_READ_EVIDENCE_POLICY_VERSION } from "../identity/managed-profile.js";
import { assertFreshPlcReaderHealth, assertPublicPlcReaders, createIndependentPlcObserver, type IndependentPlcObserver, type PublicPlcAuthorityConfig } from "./observers.js";
import { canonicalizeHailServiceBase, PlcHailDidResolver, type HailDidResolver, type ResolvedHailDid } from "./resolver.js";
import { createPlcDirectoryClient, withAbort } from "./client.js";
import { encodePublicEvidence, evidenceHash, PUBLIC_EVIDENCE_LIMITS, validatePlcAudit } from "./read-evidence.js";

function assertNoHistoryRegression(previousBytes:Uint8Array,current:readonly ExportedOp[]):void{
  const bundle=decodeDeterministic(previousBytes,PUBLIC_EVIDENCE_LIMITS) as Record<string,HailValue>;
  const witnesses=bundle.witnesses;
  if(!Array.isArray(witnesses)||!witnesses.length||!witnesses[0]||typeof witnesses[0]!=="object"||Array.isArray(witnesses[0]))
    throw new Error("Retained PLC authority evidence has no audit history");
  const rawAudit=(witnesses[0] as Record<string,HailValue>).audit;
  if(!Array.isArray(rawAudit))throw new Error("Retained PLC authority evidence has no audit history");
  const currentByCid=new Map(current.map(entry=>[entry.cid,entry]));
  for(const value of rawAudit){
    const prior=def.exportedOp.parse(value),next=currentByCid.get(prior.cid);
    if(!next||prior.did!==next.did||prior.createdAt!==next.createdAt||!isDeepStrictEqual(prior.operation,next.operation)||
      prior.nullified&&!next.nullified)throw new Error("PLC reader history regressed from retained evidence");
  }
}

export function publicPlcAuthorityConfig(environment: Record<string,string|undefined>, registry: string, providerOrigin: string): PublicPlcAuthorityConfig | undefined {
  const profile = environment.PLC_AUTHORITY_PROFILE?.trim();
  if (!profile || profile === "poc") {
    if (environment.PLC_PUBLIC_READERS || environment.PLC_PROVIDER_OPERATORS) throw new Error("Public reader declarations require PLC_AUTHORITY_PROFILE=strict-public-v1");
    return undefined;
  }
  if (profile !== "strict-public-v1" || registry !== "https://plc.directory") throw new Error("Strict public PLC authority requires the canonical public registry and an explicit supported profile");
  if ((environment.PLC_PUBLIC_READERS?.length ?? 0)>8192 || (environment.PLC_PROVIDER_OPERATORS?.length ?? 0)>8192) throw new Error("Public reader configuration exceeds its bound");
  const readers = environment.PLC_PUBLIC_READERS
    ? parseJsonWithoutDuplicateKeys(environment.PLC_PUBLIC_READERS)
    : [{origin:"https://plc.directory",operator:"plc-directory"}];
  const providers = parseJsonWithoutDuplicateKeys(environment.PLC_PROVIDER_OPERATORS ?? "null");
  if (!Array.isArray(readers) || readers.some(reader => !reader || typeof reader !== "object" || Array.isArray(reader) ||
    Object.keys(reader).length !== 2 || typeof reader.origin !== "string" || typeof reader.operator !== "string") ||
    !Array.isArray(providers)) throw new Error("Public PLC readers/operators must be explicit bounded JSON declarations");
  assertPublicPlcReaders(readers,providers,[providerOrigin]);
  return { profile, readers:readers as unknown as PublicPlcAuthorityConfig["readers"], providerOperators:providers };
}

export class VerifiedPublicPlcResolver implements HailDidResolver {
  constructor(private readonly sql: SQL, private readonly readers: readonly IndependentPlcObserver[],
    private readonly providerOperators: readonly string[], providerOrigins: readonly string[],
    private readonly now:()=>Date=()=>new Date(), private readonly timeoutMs=15_000) {
    assertPublicPlcReaders(readers,providerOperators,providerOrigins);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Public PLC resolution deadline must be 1–30000 ms");
  }

  async resolve(did: string): Promise<ResolvedHailDid> {
    if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Error("DID is not canonical did:plc");
    const signal=AbortSignal.timeout(this.timeoutMs),deadline=Date.now()+this.timeoutMs,started=this.now(),failures:unknown[]=[];
    const previous=(await withAbort(this.sql<{bundle_bytes:Uint8Array}[]>`SELECT bundle_bytes FROM public_plc_resolution_evidence
      WHERE did=${did} ORDER BY verified_at DESC LIMIT 1`,signal))[0];
    let selected:{reader:IndependentPlcObserver;resolved:ResolvedHailDid;checked:Awaited<ReturnType<typeof validatePlcAudit>>}|undefined;
    for(const [index,reader] of this.readers.entries()){
      const remaining=deadline-Date.now();
      if(remaining<=0)break;
      try{
        selected=await withAbort((async()=>{
          const [audit,health]=await Promise.all([reader.audit(did),reader.health?.()]);
          if(reader.origin!=="https://plc.directory")assertFreshPlcReaderHealth(health,started);
          const checked=await validatePlcAudit(did,audit),service=checked.state.services.hail;
          const resolved:ResolvedHailDid={did,identityDidKey:checked.state.verificationMethods["hail-identity"]!,
            messagingDidKey:checked.state.verificationMethods["hail-messaging"]!,
            serviceBase:canonicalizeHailServiceBase(service?.endpoint??""),
            evidence:{document:formatDidDoc(checked.state),data:checked.state,log:checked.log}};
          if(previous)assertNoHistoryRegression(previous.bundle_bytes,checked.audit);
          if(resolved.did!==did || resolved.identityDidKey!==checked.state.verificationMethods["hail-identity"] ||
            resolved.messagingDidKey!==checked.state.verificationMethods["hail-messaging"] || resolved.identityDidKey===resolved.messagingDidKey ||
            service?.type!=="HailMessaging" || resolved.serviceBase!==canonicalizeHailServiceBase(service.endpoint))
            throw new Error("Public PLC resolver roles/service disagree with verified full state");
          await Promise.all([ed25519PublicKeyFromDidKey(resolved.identityDidKey),ed25519PublicKeyFromDidKey(resolved.messagingDidKey)]);
          return {reader,resolved,checked};
        })(),AbortSignal.timeout(Math.min(5_000,Math.max(1,Math.floor(remaining/(this.readers.length-index))))));
        break;
      }catch(error){failures.push(error);}
    }
    if(!selected){if(failures.length===1)throw failures[0];throw new AggregateError(failures,"No configured PLC reader returned fresh valid evidence");}
    const {reader,resolved,checked}=selected;
    const verifiedAt=this.now();
    if(!Number.isFinite(started.getTime())||verifiedAt.getTime()<started.getTime()||verifiedAt.getTime()-started.getTime()>this.timeoutMs)throw new Error("Public PLC verification clock/deadline is invalid");
    const bytes=encodePublicEvidence({type:"hail.public-plc-resolution",version:1,policy:"strict-public-v1",registry_origin:"https://plc.directory",
      did,operation_cid:checked.operationCid,read_started_at:started.toISOString(),verified_at:verifiedAt.toISOString(),
      provider_operators:[...this.providerOperators],
      witnesses:[{origin:reader.origin,operator:reader.operator!,document:resolved.evidence.document,state:checked.state,log:checked.log,audit:checked.audit,
        signed_operations:checked.audit.map(entry=>({cid:entry.cid,dag_cbor:new Uint8Array(encodeDagCbor(entry.operation))}))}],
    } as unknown as HailValue);
    const digest=evidenceHash(bytes);
    await withAbort(this.sql.begin(async tx=>{
      signal.throwIfAborted();
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${did},0))`;
      const lockedPrevious=(await tx<{bundle_bytes:Uint8Array}[]>`SELECT bundle_bytes FROM public_plc_resolution_evidence
        WHERE did=${did} ORDER BY verified_at DESC LIMIT 1`)[0];
      if(lockedPrevious)assertNoHistoryRegression(lockedPrevious.bundle_bytes,checked.audit);
      await tx`INSERT INTO public_plc_resolution_evidence
        (evidence_digest,did,operation_cid,verified_at,bundle_bytes,record_version,read_evidence_policy_version)
        VALUES(${digest},${did},${checked.operationCid},${verifiedAt},${bytes},1,${PLC_READ_EVIDENCE_POLICY_VERSION})
        ON CONFLICT(evidence_digest) DO NOTHING`;
      const retained=(await tx<{bundle_bytes:Uint8Array}[]>`SELECT bundle_bytes FROM public_plc_resolution_evidence WHERE evidence_digest=${digest}`)[0];
      if(!retained||!Buffer.from(retained.bundle_bytes).equals(Buffer.from(bytes)))throw new Error("Retained public PLC resolution conflicts");
      signal.throwIfAborted();
    }),signal);
    return {...resolved,evidence:{...resolved.evidence,verification:{profile:"strict-public-v1",digest:encodeBase64Url(digest),
      operationCid:checked.operationCid,verifiedAt:verifiedAt.toISOString()}}};
  }
}

export function createHailDidResolver(config: Pick<AppConfig,"plcDirectoryUrl"|"publicOrigin"|"publicPlcAuthority">, sql: SQL): HailDidResolver {
  const policy=config.publicPlcAuthority;
  if(!policy)return new PlcHailDidResolver(createPlcDirectoryClient(config.plcDirectoryUrl));
  if(config.plcDirectoryUrl!=="https://plc.directory")throw new Error("Public PLC authority cannot use a private write registry");
  return new VerifiedPublicPlcResolver(sql,policy.readers.map(reader=>createIndependentPlcObserver(reader.origin,reader.operator)),
    policy.providerOperators,[config.publicOrigin]);
}
