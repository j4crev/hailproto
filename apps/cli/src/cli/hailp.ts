#!/usr/bin/env bun
import { parseCommand, boundedInteger } from "./options.js";
import { printResult, printError } from "./output.js";
import { listPages, waitForStatus } from "../account-reads.js";
import packageInfo from "../../package.json" with { type: "json" };
import { decodeBase64Url, toDiagnosticJson } from "@hailproto/codec";
import { AccountApiClient } from "../account-api.js";
import { privateFile, savePrivateBytes, signGrantRevocation } from "../grant-revocation.js";
import { readRecoverySecret } from "./private-input.js";
import { createGrant } from "../grant-creation.js";
import { createAccount } from "../account-creation.js";
import { createUserVault } from "../vault.js";
import { encodeBase64Url } from "@hailproto/codec";
import { sendMessage } from "../message-creation.js";
import { copyVerifiedVault, verifyVaultFile } from "../vault-backup.js";
import { createCredential } from "../credential-creation.js";
import { rotateCredential } from "../credential-rotation.js";
import { loginAccount } from "../account-login.js";
import { renewBinding,showBinding } from "../binding-renewal.js";
import { updateGrant } from "../grant-update.js";
import { transferOffer,transferStatus,cancelTransfer,selectTransferAddress,exportTransferSnapshot,signAccountTransferCutover,completeAccountTransfer } from "../account-transfer.js";
import { transitionToManaged,transitionToOwner } from "../custody-transition.js";
import {completeManagedTransfer,exportManagedTransferSnapshot,managedTransferOffer,managedTransferStatus,
  selectManagedTransferAddress,signManagedTransferCutover} from "../managed-account-transfer.js";
import {createProfile,showProfile,updateProfile} from "../sender-profile.js";

try {
  const parsed = parseCommand(Bun.argv.slice(2));
  const { values, positionals } = parsed;
  const selection = parsed.authenticated ? { provider: values.provider, accountId: values["account-id"] } : {};
  if (parsed.version) console.info(packageInfo.version);
  else if (parsed.help) console.info(parsed.help);
  else {
    const pages = boundedInteger(values.pages, "pages", 100, 1);
    const wait = values.wait === undefined ? undefined : boundedInteger(values.wait, "wait", 300, 1);
    const interval = boundedInteger(values.interval, "interval", 30, 2);
    const [group, command, argument] = positionals;
    if(group==="vault") {
      if(command==="create") {
      const generated=await createUserVault();
      try {await savePrivateBytes(values["recovery-file"]!,new TextEncoder().encode(encodeBase64Url(generated.recoverySecret)+"\n"));
        await savePrivateBytes(values.vault!,new TextEncoder().encode(JSON.stringify(generated.vault)));}
      finally {generated.recoverySecret.fill(0);}
      printResult({vaultFile:values.vault,recoveryFile:values["recovery-file"]});
      } else {
        const expectedDid = values["expected-did"] === "unbound" ? null : values["expected-did"];
        const secret = decodeBase64Url(await readRecoverySecret());
        try {
          const result = command === "verify" ? await verifyVaultFile(values.vault!, secret, expectedDid) :
            await copyVerifiedVault(command === "backup" ? values.vault! : values.file!,
              command === "backup" ? values.output! : values.vault!, secret, expectedDid);
          printResult(result);
        } finally { secret.fill(0); }
      }
    } else if(group==="account"&&command==="transfer") {
      if(argument==="complete") {
        printResult(await completeAccountTransfer(values.state!,values.snapshot!));
      }else if(argument==="sign-cutover") {
        printResult(await signAccountTransferCutover(values.vault!,values.state!,values.snapshot!,values.consent!,values.operation!,values.binding!));
      }else{
      const credential=values.credentials ?? Bun.env.HAILP_CREDENTIAL_FILE;
      if(!credential)throw new Error("Set --credentials or HAILP_CREDENTIAL_FILE");
      const client=await AccountApiClient.fromCredentialFile(credential, selection);
      const result=argument==="status"?await transferStatus(client):argument==="offer"?await transferOffer(client,values.destination!,values.vault!,values.state!):
        argument==="select"?await selectTransferAddress(client,values.username!,values.vault!,values.state!):argument==="export"?await exportTransferSnapshot(client,values.state!,values.output!):await cancelTransfer(client,values.vault!,values.state!);
      printResult(result);
      }
    } else if(group==="account"&&command==="managed-transfer") {
      if(argument==="sign-cutover") {
        printResult(await signManagedTransferCutover(values.vault!,values.state!,values.snapshot!,values.operation!,values.approval!));
      } else if(argument==="complete") {
        printResult(await completeManagedTransfer(values.state!,values.snapshot!,fetch,values["monitor-attestation"]));
      } else {
      const credential=values.credentials ?? Bun.env.HAILP_CREDENTIAL_FILE;
      if(!credential)throw new Error("Set --credentials or HAILP_CREDENTIAL_FILE");
      const client=await AccountApiClient.fromCredentialFile(credential,selection);
      printResult(argument==="status"?await managedTransferStatus(client):argument==="offer"?
        await managedTransferOffer(client,values.destination!,values.vault!,values.state!):
        argument==="export"?await exportManagedTransferSnapshot(client,values.state!,values.output!):
          await selectManagedTransferAddress(client,values.username!,values.vault!,values.state!));
      }
    } else if(group==="account"&&command==="custody") {
      const credential=values.credentials ?? Bun.env.HAILP_CREDENTIAL_FILE;
      if(!credential)throw new Error("Set --credentials or HAILP_CREDENTIAL_FILE");
      const client=await AccountApiClient.fromCredentialFile(credential,selection);
      printResult(argument==="owner-controlled"?await transitionToOwner(client,values.vault!,values.state!):
        await transitionToManaged(client,values.vault,values.state!));
    } else if(group==="account"&&command==="login") {
      printResult(await loginAccount(values.provider!, values.did!, values.signer as "identity" | "owner-recovery",
        values.scope!, values.vault!, values.state!, values.credentials!));
    } else if(group==="account"&&command==="create") {
      printResult(await createAccount(values.provider!,values.address!,values.custody as "owner-controlled"|"managed",values.vault!,values.state!,values.credentials!,undefined,
        values["monitor-origin"]?{origin:values["monitor-origin"],publicKey:values["monitor-key"]!,...(values["monitor-attestation"]?{attestationPath:values["monitor-attestation"]}:{})}:undefined));
    } else {
    const credential = values.credentials ?? Bun.env.HAILP_CREDENTIAL_FILE;
    if (!credential) throw new Error("Set --credentials or HAILP_CREDENTIAL_FILE");
    const client = await AccountApiClient.fromCredentialFile(credential, selection);
    let result: unknown;
    if (group === "account") result = await client.account();
    else if(group==="profile")result=command==="show"?await showProfile(client):command==="create"?
      await createProfile(client,values.file!):await updateProfile(client,values.file!);
    else if(group==="binding") {
      if(command==="show")result=await showBinding(client);
      else result=await renewBinding(client,values.output!,Number(values["expires-at"]),values.vault);
    }
    else if(group==="send"||group==="reply") {
      const until=values["reply-until"]===undefined?undefined:Number(values["reply-until"]);
      result=await sendMessage(client,values.file!,values.state!,group==="send"?values.grant:undefined,values.category?.[0],group==="reply"?command:undefined,until);
    }
    else if(group==="inbox")result=command==="list"?await listPages(client,"inbox",values.after,pages):
      await client.request(`/inbox/${encodeURIComponent(argument!)}/${encodeURIComponent(positionals[3]!)}`);
    else if(group==="message")result=command==="status"?await waitForStatus(client,argument!,wait,interval):
      await client.request(`/messages/${encodeURIComponent(argument!)}/submit`,{});
    else if(group==="credential") {
      if(command==="revoke")result=await client.request("/credentials",{revoke:argument!});
      else if(command==="rotate")result=await rotateCredential(credential, values.output!);
      else if(command==="list")result=await listPages(client,"credentials",values.after,pages);
      else result=await createCredential(client, values.output!, values.scope);
    }
    else if(command==="update") {
      const expiry=values["no-expiry"]?null:values["expires-at"]===undefined?undefined:Number(values["expires-at"]);
      result=await updateGrant(client,argument!,values.category ?? null,values.output!,values.vault,expiry,values["refresh-consent"] ?? false,values.sender);
    }
    else if (command === "list") result = await listPages(client,"grants",values.after,pages);
    else if (command === "create") {
      const expiry = values["no-expiry"] ? null : values["expires-at"] === undefined ? undefined : Number(values["expires-at"]);
      result = await createGrant(client,argument!,values.category ?? null,values.vault ?? "",values.output!,expiry);
    }
    else if (command === "submit") result = await client.submit(await privateFile(argument!, 262_144));
    else {
      const account = await client.account();
      if (command === "revoke" && !account.scopes.includes("grants:write")) {
        throw new Error("Credential has no Grant write permission");
      }
      const grant = await client.grant(argument!);
      if (command === "show") {
        if (values.output) await savePrivateBytes(values.output, grant.representation);
        result = { grantId: grant.payload.grant_id, localRole: grant.localRole, digest: grant.digest,
          grant: toDiagnosticJson("hail.grant", grant.payload) };
      } else {
        if(account.custodyProfile==="managed") {
          if(values.vault)throw new Error("Managed signing does not take the owner's identity vault");
          result=await client.request(`/grants/${argument!}/revoke`,{});
        } else {
        if (!values.vault || !values.output) throw new Error("Revoke requires --vault and --output for exact retries");
        if (grant.localRole !== "grantor" || grant.payload.grantor !== account.did) {
          throw new Error("Only the authoritative grantor account can revoke this Grant");
        }
        if (account.migrationState) throw new Error("Account is migration-fenced; use the current provider after transfer");
        const secret = decodeBase64Url(await readRecoverySecret());
        try {
          const signed = await signGrantRevocation(values.vault, grant.representation, grant.payload.grant_id,
            grant.payload.consent_context.grantee_address, values.output, secret, account.did);
          result = await client.submit(signed);
        } finally { secret.fill(0); }
        }
      }
    }
    printResult(result);
    }
  }
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
