import { encodeDeterministic,type HailGrant,type HailValue } from "@hailproto/codec";
export const equalGrantValue=(a:unknown,b:unknown)=>Buffer.from(encodeDeterministic(a as HailValue)).equals(Buffer.from(encodeDeterministic(b as HailValue)));

export function expandsAuthorization(current:HailGrant,next:HailGrant):boolean {
  if(next.status==="revoked")return false;
  const old=current.scope[0]!,scope=next.scope[0]!;
  return old.type!==scope.type || old.type==="categories"&&scope.type==="categories"&&scope.values.some(value=>!old.values.includes(value)) ||
    current.expires_at!==null&&(next.expires_at===null||next.expires_at>current.expires_at);
}
export function restrictsAuthorization(current:HailGrant,next:HailGrant):boolean {
  return !expandsAuthorization(current,next)&&(!equalGrantValue(current.scope,next.scope)||current.expires_at!==next.expires_at||next.status==="revoked");
}
