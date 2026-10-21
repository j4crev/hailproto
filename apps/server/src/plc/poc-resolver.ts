import {createHash} from "node:crypto";
import {cidForCbor} from "@atproto/common";
import {encodeBase64Url} from "@hailproto/codec";
import type {HailDidResolver,ResolvedHailDid} from "./resolver.js";

// One configured private registry is sufficient for POC retry/cutover proof,
// but is deliberately labeled poc-local rather than independent public evidence.
export class PrivatePocManagedResolver implements HailDidResolver {
  constructor(private readonly resolver:HailDidResolver) {}
  async resolve(did:string):Promise<ResolvedHailDid> {
    const resolved=await this.resolver.resolve(did),last=resolved.evidence.log.at(-1);
    if(!last)throw new Error("Private POC managed authority has no PLC operation");
    const operationCid=(await cidForCbor(last)).toString();
    const digest=encodeBase64Url(new Uint8Array(createHash("sha256").update(operationCid).digest()));
    return {...resolved,evidence:{...resolved.evidence,verification:{profile:"poc-local",digest,
      operationCid,verifiedAt:new Date().toISOString()}}};
  }
}
