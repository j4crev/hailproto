<script lang="ts">
  import {onMount,onDestroy} from "svelte";
  import {startRegistration,startAuthentication} from "@simplewebauthn/browser";
  import {decodeBase64Url} from "@hailproto/codec/base64url";
  import {createSignupBackup,verifySignupBackup,signSignupGenesis,encodeBase64Url,type UserVaultFile} from "$lib/signup-recovery.js";
  import {PENDING_STORAGE,setupToken,pendingKey,sealPending,openPending,enrollmentHash,signupRequest,checkSummary,SignupRequestError,
    type PendingSignup,type SignupSummary} from "$lib/signup.js";
  let {data}=$props();
  let local=$state(""),email=$state(""),invitation=$state(""),consent=$state(false);
  let vault=$state<UserVaultFile|null>(null),secret=$state(""),enteredSecret=$state("");
  let backupFile=$state<File|null>(null),resumeFile=$state<File|null>(null);
  let backupSaved=$state(false),secretSaved=$state(false),pendingSaved=$state(false);
  let finalBackupSaved=$state(false),finalVault=$state<UserVaultFile|null>(null);
  let pending=$state<PendingSignup|null>(null),summary=$state<SignupSummary|null>(null);
  let cached=$state(false),emailVerified=$state(false),code=$state(""),label=$state("Hail passkey");
  let busy=$state(false),message=$state(""),complete=$state(false),retryAt=$state(0),emailRetryAt=$state(0),now=$state(Date.now());
  let key:CryptoKey|null=null,encrypted="",epoch=0;
  const phases=["Invitation","Recovery kit","Account setup","Ready"];
  let phase=$derived(complete?3:pending?2:vault?1:0);
  let emailInput=$state<HTMLInputElement>();
  const urls=new Set<string>();
  const request=signupRequest;
  function clearMemory(){epoch++;vault=null;secret="";enteredSecret="";pending=null;summary=null;key=null;encrypted="";invitation="";code="";
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();}
  onDestroy(clearMemory);
  onMount(()=>{
    try{cached=!!localStorage.getItem(PENDING_STORAGE);}catch{message="Browser storage is unavailable. Allow local storage to use resumable signup.";}
    const params=new URLSearchParams(location.hash.slice(1));invitation=params.get("invitation")??"";
    if(location.hash)history.replaceState(null,"",location.pathname);
    const timer=setInterval(()=>{now=Date.now();},1000);
    window.addEventListener("pagehide",clearMemory);
    return()=>{clearInterval(timer);window.removeEventListener("pagehide",clearMemory);};
  });
  function download(text:string,name:string){
    const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));urls.add(url);
    const a=document.createElement("a");a.href=url;a.download=name;a.click();
  }
  async function run(action:()=>Promise<void>){
    if(busy||Date.now()<retryAt)return;
    busy=true;message="";
    try{await action();}catch(error){
      if(error instanceof SignupRequestError){message=error.message;if([202,429,503].includes(error.status))retryAt=Date.now()+error.retryAfter*1000;}
      else message="This step could not finish. Check the saved file or secret, or retry with the same setup. Do not create replacement keys.";
    }finally{enteredSecret="";code="";busy=false;}
  }
  async function persist(){
    if(!pending||!key)throw new Error("No setup");
    encrypted=await sealPending($state.snapshot(pending),key);
    localStorage.setItem(PENDING_STORAGE,encrypted);cached=true;
  }
  async function generate(){
    if(!consent||cached||pending||vault||!invitation||!email||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local))return;
    if(!emailInput?.reportValidity())return;
    const checked=await request("/api/v1/signup/check-address",{address:`${local}@${new URL(data.policy.provider).hostname}`,invitation},setupToken());
    if(checked.available!==true){message="That address is already held. Choose another before creating recovery keys.";return;}
    const current=epoch,generated=await createSignupBackup();
    try{if(current!==epoch)return;vault=generated.vault;secret=encodeBase64Url(generated.recoverySecret);}
    finally{generated.recoverySecret.fill(0);}
  }
  async function verifyBackup(){
    if(!vault||!backupFile||backupFile.size>16_384||!backupSaved||!secretSaved)return;
    const current=epoch,expected=$state.snapshot(vault);
    await verifySignupBackup(await backupFile.text(),enteredSecret.trim(),expected);
    const unlocked=await pendingKey(enteredSecret.trim());
    if(current!==epoch)return;
    key=unlocked;
    pending={type:"hail.pending-signup",version:1,policy:data.policy,signupId:crypto.randomUUID(),
      address:`${local}@${new URL(data.policy.provider).hostname}`,email,token:setupToken(),enrollmentToken:setupToken(),
      invitation,vault:expected,operation:null,did:null};
    await persist();secret="";vault=null;backupFile=null;invitation="";
    message="Recovery verified. Save your encrypted setup file before reserving the address.";
  }
  async function restore(){
    const text=resumeFile?(resumeFile.size<=65_536?await resumeFile.text():""):localStorage.getItem(PENDING_STORAGE);
    if(!text)throw new Error("Choose saved setup");
    const current=epoch,unlocked=await pendingKey(enteredSecret.trim()),value=await openPending(text,unlocked,data.policy);
    if(current!==epoch)return;
    key=unlocked;pending=value;encrypted=text;pendingSaved=true;emailVerified=false;
    await persist();
    try{summary=checkSummary(await request(`/api/v1/signup/${value.signupId}`,undefined,value.token),value);}
    catch(error){if(!(error instanceof SignupRequestError&&[401,404].includes(error.status)))throw error;}
    if(!pending.did&&summary?.did){pending.did=summary.did;await persist();}
    message="Original setup reopened. Continue with the same address and keys. If you already finished, sign in to retire any remaining setup authority.";
  }
  async function prepare(){
    if(!pending||!pendingSaved)return;
    const p=$state.snapshot(pending);
    const value=await request("/api/v1/signup",{signupId:p.signupId,address:p.address,recoveryKey:p.vault.recovery.publicDidKey,
      identityKey:p.vault.identity.publicDidKey,enrollmentHash:await enrollmentHash(p.enrollmentToken),invitation:p.invitation,
      backupVerified:true,managedAccepted:true,alphaMonitoringAccepted:true},p.token);
    summary=checkSummary(value,p);message="Address reserved for this setup. Verify your external security-alert email.";
  }
  async function sendCode(resend=false){
    if(!pending)return;
    const result=await request("/api/v1/signup-email/start",{signupId:pending.signupId,email:pending.email,...(resend?{resend:true}:{})},pending.token);
    emailVerified=result.verified===true;
    message=emailVerified?"Email already verified for this setup.":"Check your external inbox for the eight-digit code. Check spam too.";
    emailRetryAt=Date.now()+30_000;
  }
  async function verifyEmail(){
    if(!pending)return;
    const result=await request("/api/v1/signup-email/verify",{signupId:pending.signupId,code},pending.token);
    if(result.verified!==true)throw new Error("Email not verified");
    emailVerified=true;message="External alert destination verified. Email is not a recovery bypass.";
  }
  async function sign(){
    if(!pending||!summary?.preparation||pending.operation||summary.state!=="prepared"||!emailVerified)return;
    const raw=decodeBase64Url(enteredSecret.trim(),32);
    try{
      const signed=await signSignupGenesis($state.snapshot(pending.vault),raw,summary.preparation,{...data.policy,address:pending.address});
      pending.operation=signed.operation;pending.did=signed.did;pendingSaved=false;
      await persist();message="Exact identity signed locally, not yet submitted. Save the updated setup file before publishing.";
    }finally{raw.fill(0);}
  }
  async function advance(){
    if(!pending||!pendingSaved)return;
    const p=$state.snapshot(pending);
    summary=checkSummary(await request(`/api/v1/signup/${p.signupId}/advance`,{
      enrollmentToken:p.enrollmentToken,...(p.operation?{operation:p.operation}:{})},p.token),p);
    message=summary.state==="awaiting-monitor"?"Identity submitted. Waiting for current monitoring and a security alert accepted for your verified email. Retry in 15 seconds.":"Account activation checked. Continue with your passkey.";
    if(summary.state==="awaiting-monitor")retryAt=Date.now()+15_000;
  }
  async function enroll(){
    if(!pending||summary?.state!=="passkey-enrollment")return;
    const start=await request("/api/v1/auth/passkeys/recovery/options",{token:pending.enrollmentToken});
    const response=await startRegistration({optionsJSON:start.options});
    await request("/api/v1/auth/passkeys/recovery",{token:pending.enrollmentToken,challengeId:start.challengeId,response,label});
    summary=checkSummary(await request(`/api/v1/signup/${pending.signupId}`,undefined,pending.token),pending);
    message="Passkey created. Sign in with it now to finish and retire setup authority.";
  }
  async function checkEnrollment(){
    if(!pending)return;
    summary=checkSummary(await request(`/api/v1/signup/${pending.signupId}`,undefined,pending.token),pending);
    message=summary.state==="sign-in-required"?"Your passkey is registered. Sign in to finish setup.":
      "Passkey registration is not confirmed. Use Create passkey if enrollment is still open; do not start another signup.";
  }
  async function finish(){
    if(!pending||!finalBackupSaved||summary?.state!=="sign-in-required")return;
    await checkEnrollment();
    if(summary.state!=="sign-in-required")return;
    const start=await request("/api/v1/auth/passkeys/authentication/options",{});
    const response=await startAuthentication({optionsJSON:start.options});
    await request("/api/v1/auth/passkeys/authentication",{challengeId:start.challengeId,response});
    const result=await request(`/api/v1/signup/${pending.signupId}/complete`,{});
    if(result.state!=="complete"||result.signupId!==pending.signupId)throw new Error("Setup not completed");
    finalVault={...$state.snapshot(pending.vault),did:pending.did??summary?.did??null};
    localStorage.removeItem(PENDING_STORAGE);clearMemory();complete=true;cached=false;
    message="Setup complete. Temporary setup authority is retired. Delete obsolete pending setup files; keep your recovery backup and separate secret.";
  }
</script>

<svelte:head><title>Create your account · Haili</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<ol class="m-0 mb-6 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4" aria-label="Signup steps">{#each phases as name,index}<li class={["flex items-center gap-2 rounded-xl px-3 py-3 text-xs font-semibold",index===phase?"bg-brand-soft text-brand-strong":"text-muted"]} aria-current={index===phase?"step":undefined}><span class="grid size-6 shrink-0 place-items-center rounded-full border border-solid border-line" aria-hidden="true">{index+1}</span>{name}</li>{/each}</ol>
<section class="hail-card flex flex-col gap-5 p-7 max-[540px]:p-[18px]
  [&_h1]:m-0 [&_h2]:m-0 [&_h2]:text-[19px] [&_p]:m-0 [&_p]:leading-[1.6]
  [&_label]:block [&_label]:leading-[1.6]
  [&_input:not([type=checkbox])]:block [&_input:not([type=checkbox])]:w-full [&_input:not([type=checkbox])]:min-w-0
  [&_input:not([type=checkbox])]:rounded-md [&_input:not([type=checkbox])]:border [&_input:not([type=checkbox])]:border-solid
  [&_input:not([type=checkbox])]:border-line [&_input:not([type=checkbox])]:p-2.5 [&_input:not([type=checkbox])]:[font:inherit]
  [&_label]:text-sm [&_label>input]:mt-2 [&_p]:text-sm [&_p]:text-muted [&_button]:self-start [&_button]:max-w-full [&_button]:whitespace-normal
  [&_button:disabled]:opacity-60 [&_button:disabled]:cursor-not-allowed
  [&_code]:[overflow-wrap:anywhere] [&_code]:whitespace-pre-wrap [&_code]:[word-break:break-word]
  [&_pre]:[overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:[word-break:break-word] [&_pre]:text-[12px]" aria-busy={busy}>
  <p class="hail-eyebrow text-brand!">Invitation-only alpha</p><h1 class="hail-title">Create your Hail account</h1>
  <p>Reduced-assurance alpha · managed identity. Keep your recovery material under your own control.</p>
  {#if complete}
    <h2>Your account is ready</h2><p>Keep your encrypted recovery backup and its secret separately. A second passkey is useful but is not independent identity recovery.</p>
    {#if finalVault}<button class="hail-button-secondary" onclick={()=>download(JSON.stringify(finalVault,null,2),"hail-account-recovery.vault.json")}>Save account recovery backup again</button>{/if}
    <div class="flex flex-wrap gap-3"><a class="hail-button" href="/">Open your inbox</a><a class="hail-button-secondary" href="/settings/security">Manage passkeys</a></div>
  {:else if !pending && !vault}
    {#if !cached}
      <h2>Start with an invitation</h2>
      <label>Invitation<input type="password" bind:value={invitation} autocomplete="off" maxlength="2048" /></label>
      <label>Your Hail address<div class="flex flex-wrap items-center gap-[5px] [&_input]:!w-[200px]"><input bind:value={local} pattern={'[a-z0-9][a-z0-9._-]{0,63}'} maxlength="64" autocomplete="username" />@{new URL(data.policy.provider).hostname}</div></label>
      <p>Availability is checked before creating keys. The address is reserved when you submit your verified setup; another user could reserve it first.</p>
      <label>External security-alert email<input type="email" bind:this={emailInput} bind:value={email} autocomplete="email" maxlength="254" required /></label>
      <p>Your provider signs everyday Hail permissions. You retain separate owner recovery authority. Your address, identity keys and service endpoint will be permanently public after publication; cancellation cannot erase that identity.</p>
      <p class="rounded-xl bg-warning-soft p-4 text-warning!"><strong>Reduced-assurance alpha:</strong> the monitor is operated by the same operator as your provider. It detects unexpected changes and coverage gaps but does not independently protect against that operator suppressing alerts. Recovery is time-sensitive; a backup alone is not a guarantee.</p>
      <p>This page temporarily uses recovery keys in your browser. Compromised page code or your device could steal them. Never share the backup and secret together. Email alerts and passkeys do not replace recovery authority.</p>
      <label><input type="checkbox" bind:checked={consent} /> I choose managed custody, accept these alpha limitations and permanent publication, and will save and verify my own recovery material.</label>
      <button class="hail-button" disabled={busy||!consent||!invitation||!email||!local} onclick={()=>run(generate)}>Create recovery kit locally</button>
    {/if}
    <details class="rounded-xl border border-solid border-line p-4" open={cached}><summary class="cursor-pointer text-sm font-semibold">Continue an interrupted setup</summary><div class="mt-4 grid gap-4"><p>{cached?"Encrypted setup was found on this browser.":"Reopen an encrypted pending setup file if you already started. Do not make replacement keys."} This is only for unfinished signup, not recovery of an existing account.</p><label>Pending setup file (optional if saved in this browser)<input type="file" accept=".json,application/json" onchange={e=>{resumeFile=e.currentTarget.files?.[0]??null;}} /></label><label>Separate recovery secret<input type="password" bind:value={enteredSecret} autocomplete="off" spellcheck="false" maxlength="43" /></label><button class="hail-button-secondary justify-self-start" disabled={busy||(!cached&&!resumeFile)||!enteredSecret} onclick={()=>run(restore)}>Continue setup</button></div></details>
  {:else if vault}
    <h2>Save and verify recovery</h2>
    <button class="hail-button" disabled={busy} onclick={()=>{if(vault){download(JSON.stringify(vault,null,2),"hail-recovery.vault.json");backupSaved=true;}}}>Save encrypted recovery backup</button>
    <p>Store this secret in a password manager or on paper, separately from the backup. Anyone with both can unlock your owner keys.</p>
    <code data-recovery-secret class="select-all rounded-xl border border-solid border-line bg-canvas p-4">{secret}</code>
    <label><input type="checkbox" bind:checked={secretSaved} /> I saved the secret separately.</label>
    <label>Reopen the saved recovery backup<input type="file" accept=".json,application/json" onchange={e=>{backupFile=e.currentTarget.files?.[0]??null;}} /></label>
    <label>Secret from your separate copy<input type="password" bind:value={enteredSecret} autocomplete="off" spellcheck="false" maxlength="43" /></label>
    <button class="hail-button" disabled={busy||!backupFile||!backupSaved||!secretSaved||!enteredSecret} onclick={()=>run(verifyBackup)}>Verify saved recovery kit</button>
  {:else if pending}
    <h2 class="[overflow-wrap:anywhere]">{pending.address}</h2>
    <p>Setup is encrypted in this browser with your separate recovery secret, never stored with that secret. Save an encrypted setup file too: browser storage can be cleared or lost. Setup authority lasts 24 hours; passkey enrollment lasts 10 minutes once issued.</p>
    <button class="hail-button-secondary" disabled={busy} onclick={()=>{download(encrypted,"hail-pending-setup.json");pendingSaved=true;}}>Save encrypted {pending.operation?"signed ":""}setup file</button>
    {#if !summary}
      <button class="hail-button" disabled={busy||!pendingSaved} onclick={()=>run(prepare)}>Check and reserve this address</button>
    {:else}
      <p class="rounded-xl bg-brand-soft p-4 text-brand-strong!">Progress: <strong>{summary.state}</strong> · setup expires {new Date(summary.expiresAt).toLocaleString()}</p>
      {#if summary.state==="prepared"&&!pending.operation}
        <h2>Verify external security alerts</h2><p>Destination: {pending.email}</p>
        <button class="hail-button" disabled={busy||now<retryAt||now<emailRetryAt} onclick={()=>run(()=>sendCode())}>Send code / check verification</button>
        <button class="hail-button-secondary" disabled={busy||now<retryAt||now<emailRetryAt} onclick={()=>run(()=>sendCode(true))}>Resend code</button>
        <label>Eight-digit code<input bind:value={code} inputmode="numeric" autocomplete="one-time-code" maxlength="8" /></label>
        <button class="hail-button" disabled={busy||now<retryAt||!/^\d{8}$/.test(code)} onclick={()=>run(verifyEmail)}>Verify email</button>
        {#if emailVerified}
          <h2>Review and sign your exact identity</h2>
          <p>Provider: {data.policy.provider} · Monitor: {data.policy.monitorOrigin} (same operator).</p>
          <details><summary>Exact public identity preparation</summary><pre>{JSON.stringify(summary.preparation,null,2)}</pre></details>
          <label>Recovery secret (used locally once to sign)<input type="password" bind:value={enteredSecret} autocomplete="off" spellcheck="false" maxlength="43" /></label>
          <button class="hail-button" disabled={busy||!enteredSecret||now<retryAt} onclick={()=>run(sign)}>Sign this identity locally</button>
        {/if}
      {/if}
      {#if pending.operation&&summary.state==="prepared"||summary.state==="awaiting-monitor"||summary.state==="preparing"}
        {#if pending.did}<p>Retained public identity: <code>{pending.did}</code></p>{/if}
        <p>Publishing is permanent. Retries reuse this identity and wait for verified email, monitoring and activation; they do not make another identity.</p>
        <button class="hail-button" disabled={busy||!pendingSaved||now<retryAt} onclick={()=>run(advance)}>{summary.state==="prepared"?"Publish and activate this identity":"Retry activation with original state"}</button>
      {:else if summary.state==="passkey-enrollment"}
        <h2>Create your passkey</h2><p>Enrollment expires {summary.enrollmentExpiresAt?new Date(summary.enrollmentExpiresAt).toLocaleString():"soon"}. Create a passkey first; sign-in will appear after registration is confirmed. If creation may already have succeeded, check its status instead of creating another.</p>
        <label>Passkey name<input bind:value={label} maxlength="80" /></label>
        <button class="hail-button" disabled={busy||!label.trim()} onclick={()=>run(enroll)}>Create passkey</button>
      {:else if summary.state==="enrollment-expired"}
        <p>Passkey enrollment expired. Do not create a replacement identity. Keep your original recovery kit and setup file and contact the provider about the existing owner-proof recovery path.</p>
      {/if}
      {#if summary.state==="passkey-enrollment"||summary.state==="enrollment-expired"}
        <button class="hail-button-secondary" disabled={busy||now<retryAt} onclick={()=>run(checkEnrollment)}>Check passkey registration status</button>
      {/if}
    {/if}
    {#if pending.did||summary?.did}
      <p>Save the final recovery backup with your public account identity attached. It uses the same separate recovery secret; keep it instead of the initial unbound backup.</p>
      <button class="hail-button-secondary" disabled={busy} onclick={()=>{if(pending){download(JSON.stringify({...$state.snapshot(pending.vault),did:pending.did??summary?.did},null,2),"hail-account-recovery.vault.json");finalBackupSaved=true;}}}>Save account recovery backup</button>
      {#if summary?.state==="sign-in-required"}
        <button class="hail-button" disabled={busy||!finalBackupSaved} onclick={()=>run(finish)}>Sign in with a created passkey and finish setup</button>
      {/if}
    {/if}
    <p>Closing this tab clears unlocked page memory, not the encrypted pending setup. After publication there is no erase-and-start-over action.</p>
  {/if}
  {#if busy}<p role="status">Working… keep this page open.</p>{/if}
  {#if now<retryAt}<p>Retry available in {Math.ceil((retryAt-now)/1000)} seconds.</p>{/if}
  {#if message}<p class="rounded-xl border border-solid border-line bg-canvas p-4" role="status">{message}</p>{/if}
</section>
