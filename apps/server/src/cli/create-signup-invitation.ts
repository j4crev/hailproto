import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createSignupInvitation } from "../onboarding/invitation.js";

const [output]=Bun.argv.slice(2),key=process.env.ALPHA_SIGNUP_INVITE_KEY,origin=process.env.PUBLIC_ORIGIN;
if(!output||Bun.argv.length!==3||!key||!origin)throw new Error("Usage: bun src/cli/create-signup-invitation.ts <private-output-file>; set PUBLIC_ORIGIN and private ALPHA_SIGNUP_INVITE_KEY");
const parent=await stat(dirname(output));
if(!parent.isDirectory()||(parent.mode&0o077)!==0)throw new Error("Invitation output requires a private directory");
const invitation=createSignupInvitation(origin,key),file=await open(output,"wx",0o600);
try{await file.writeFile(JSON.stringify({type:"hail.signup.invitation-file",version:1,provider:origin,invitation}));}finally{await file.close();}
console.info(JSON.stringify({invitationFile:output,provider:origin,expiresInDays:7}));
