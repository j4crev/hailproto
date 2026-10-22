import {createHash,generateKeyPairSync,randomBytes,sign} from "node:crypto";
import {encodeBase64Url} from "@hailproto/codec";

export function virtualPasskey(){
  const id=encodeBase64Url(randomBytes(32)),keys=generateKeyPairSync("ec",{namedCurve:"prime256v1"}),
    jwk=keys.publicKey.export({format:"jwk"}),cose=Buffer.concat([Buffer.from("a5010203262001215820","hex"),
      Buffer.from(jwk.x!,"base64url"),Buffer.from("225820","hex"),Buffer.from(jwk.y!,"base64url")]);
  const text=(value:string)=>Buffer.concat([Buffer.from([0x60+value.length]),Buffer.from(value)]);
  return {
    id,
    registration(challenge:string,rpId:string,origin:string){
      const client=Buffer.from(JSON.stringify({type:"webauthn.create",challenge,origin})),credentialId=Buffer.from(id,"base64url"),
        authenticator=Buffer.alloc(55+credentialId.length+cose.length);
      createHash("sha256").update(rpId).digest().copy(authenticator);authenticator[32]=69;
      authenticator.writeUInt16BE(credentialId.length,53);credentialId.copy(authenticator,55);cose.copy(authenticator,55+credentialId.length);
      const attestation=Buffer.concat([Buffer.from([0xa3]),text("fmt"),text("none"),text("attStmt"),Buffer.from([0xa0]),
        text("authData"),Buffer.from([0x58,authenticator.length]),authenticator]);
      return {id,rawId:id,type:"public-key" as const,response:{clientDataJSON:client.toString("base64url"),
        attestationObject:attestation.toString("base64url"),transports:["usb" as const]},clientExtensionResults:{}};
    },
    authentication(challenge:string,rpId:string,origin:string,counter=1){
      const client=Buffer.from(JSON.stringify({type:"webauthn.get",challenge,origin})),authenticator=Buffer.alloc(37);
      createHash("sha256").update(rpId).digest().copy(authenticator);authenticator[32]=5;authenticator.writeUInt32BE(counter,33);
      const signature=sign("sha256",Buffer.concat([authenticator,createHash("sha256").update(client).digest()]),keys.privateKey);
      return {id,rawId:id,type:"public-key" as const,response:{clientDataJSON:client.toString("base64url"),
        authenticatorData:authenticator.toString("base64url"),signature:signature.toString("base64url")},clientExtensionResults:{}};
    }
  };
}
