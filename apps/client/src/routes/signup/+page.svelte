<script lang="ts">
  import {onMount,onDestroy} from "svelte";
  import CopyButton from "$lib/CopyButton.svelte";
  import {startRegistration,startAuthentication} from "@simplewebauthn/browser";
  import {decodeBase64Url} from "@hailproto/codec/base64url";
  import {createSignupBackup,signSignupGenesis,encodeBase64Url} from "$lib/signup-recovery.js";
  import {PENDING_STORAGE,setupToken,pendingKey,sealPending,openPending,enrollmentHash,signupRequest,checkSummary,SignupRequestError,
    type PendingSignup,type SignupSummary} from "$lib/signup.js";
  import {makeRecoveryPackage,openRecoveryPackage,recoveryOperationDigest} from "$lib/signup-package.js";
  let {data}=$props();
  type Screen="address"|"protection"|"save"|"verify"|"email"|"publish"|"activating"|"passkey"|"signin"|"expired"|"done"|"resume";
  let screen=$state<Screen>("address"),local=$state(""),email=$state(""),invitation=$state(""),consent=$state(false);
  let secret=$state(""),enteredSecret=$state(""),secretSaved=$state(false),downloaded=$state(false);
  let file=$state<File|null>(null),cached=$state(false),pending=$state<PendingSignup|null>(null),summary=$state<SignupSummary|null>(null);
  let busy=$state(false),message=$state(""),code=$state(""),emailVerified=$state(false),label=$state("Hail passkey");
  let retryAt=$state(0),emailRetryAt=$state(0),now=$state(Date.now()),attempts=$state(0),packageText=$state("");
  let key:CryptoKey|null=null,epoch=0;
  const urls=new Set<string>();
  const maxActivationAttempts=24;
  const phases=["Your address","Protection","Recovery kit","Security email","Create account","Passkey"];
  const phase=$derived(screen==="address"||screen==="resume"?0:screen==="protection"?1:screen==="save"||screen==="verify"?2:screen==="email"?3:screen==="publish"||screen==="activating"?4:5);
  const headings:Record<Screen,string>={address:"Choose your Hail address",protection:"How your account is protected",save:"Save your recovery kit",verify:"Check your saved recovery kit",
    email:"Verify your security email",publish:"Ready to create your account",activating:"Creating your account",passkey:"Create your passkey",signin:"Try your new passkey",expired:"Continue with your existing account",done:"Your account is ready",resume:"Continue your setup"};
  function go(next:Screen){screen=next;message="";file=null;requestAnimationFrame(()=>document.getElementById("signup-heading")?.focus());}
  function clearMemory(){epoch++;secret="";enteredSecret="";pending=null;summary=null;key=null;packageText="";invitation="";code="";
    for(const url of urls)URL.revokeObjectURL(url);urls.clear();}
  onDestroy(clearMemory);
  onMount(()=>{
    try{cached=!!localStorage.getItem(PENDING_STORAGE);if(cached)screen="resume";}catch{message="Browser storage is unavailable. Allow local storage to continue safely.";}
    const params=new URLSearchParams(location.hash.slice(1));invitation=params.get("invitation")??"";
    if(location.hash)history.replaceState(null,"",location.pathname);
    const hide=()=>{clearMemory();screen="resume";};
    const timer=setInterval(()=>{now=Date.now();if(screen==="activating"&&!busy&&now>=retryAt&&attempts<maxActivationAttempts&&document.visibilityState==="visible")void run(advance);},1000);
    window.addEventListener("pagehide",hide);
    return()=>{clearInterval(timer);window.removeEventListener("pagehide",hide);};
  });
  async function request(...args:Parameters<typeof signupRequest>){
    const current=epoch,result=await signupRequest(...args);
    if(current!==epoch)throw new Error("Setup page closed");
    return result;
  }
  async function run(action:()=>Promise<void>){
    if(busy||Date.now()<retryAt)return;
    busy=true;message="";
    try{await action();}catch(error){
      if(error instanceof SignupRequestError){message=error.message;if([202,429,503].includes(error.status))retryAt=Date.now()+error.retryAfter*1000;else if(screen==="activating")attempts=maxActivationAttempts;}
      else {message="This step could not finish. Check your file or secret and try again with the same setup.";if(screen==="activating")attempts=maxActivationAttempts;}
    }finally{enteredSecret="";busy=false;}
  }
  function download(){
    if(!packageText)return;
    const url=URL.createObjectURL(new Blob([packageText],{type:"application/json"}));urls.add(url);
    const a=document.createElement("a");a.href=url;a.download="hail-recovery-package.json";a.click();downloaded=true;
  }
  async function persist(){
    if(!pending||!key)throw new Error("No setup");
    const current=epoch,sealed=await sealPending($state.snapshot(pending),key);
    if(current!==epoch)throw new Error("Setup page closed");
    localStorage.setItem(PENDING_STORAGE,sealed);cached=true;
  }
  async function chooseAddress(){
    const result=await request("/api/v1/signup/check-address",{address:`${local}@${new URL(data.policy.provider).hostname}`,invitation},setupToken());
    if(result.available!==true){message="That address is already taken. Please choose another.";return;}
    go("protection");
  }
  async function prepareAndSign(raw:Uint8Array){
    if(!pending||!key)return;
    const current=epoch,p=$state.snapshot(pending);
    await persist();
    if(!summary)summary=checkSummary(await request("/api/v1/signup",{signupId:p.signupId,address:p.address,
      recoveryKey:p.vault.recovery.publicDidKey,identityKey:p.vault.identity.publicDidKey,enrollmentHash:await enrollmentHash(p.enrollmentToken),
      invitation:p.invitation,backupVerified:p.version===1,managedAccepted:true,alphaMonitoringAccepted:true},p.token),p);
    if(!pending.operation){
      if(!summary.preparation)throw new Error("Preparation unavailable");
      const signed=await signSignupGenesis(p.vault,raw,summary.preparation,{...data.policy,address:p.address});
      if(current!==epoch||!pending)throw new Error("Setup page closed");
      pending.operation=signed.operation;pending.did=signed.did;
      await persist();
    }
    const packaged=await makeRecoveryPackage($state.snapshot(pending),key);
    if(current!==epoch)throw new Error("Setup page closed");
    packageText=packaged;
  }
  async function generate(){
    if(!consent)return;
    go("save");
    if(pending){const raw=decodeBase64Url(secret||enteredSecret.trim(),32);try{await prepareAndSign(raw);}finally{raw.fill(0);}return;}
    const current=epoch,generated=await createSignupBackup();
    try{
      if(current!==epoch)return;
      secret=encodeBase64Url(generated.recoverySecret);key=await pendingKey(secret);
      pending={type:"hail.pending-signup",version:2,policy:data.policy,signupId:crypto.randomUUID(),
        address:`${local}@${new URL(data.policy.provider).hostname}`,email,token:setupToken(),enrollmentToken:setupToken(),invitation,
        vault:generated.vault,operation:null,did:null};
      // Preserve original intent before making any provider request.
      await persist();await prepareAndSign(generated.recoverySecret);
    }finally{generated.recoverySecret.fill(0);}
  }
  async function verifyPackage(){
    if(!pending||!file||file.size>98_304)throw new Error("Choose the saved package");
    await openRecoveryPackage(await file.text(),enteredSecret.trim(),data.policy,$state.snapshot(pending));
    if(pending.version===2)summary=checkSummary(await request(`/api/v1/signup/${pending.signupId}/verify-backup`,
      {backupVerified:true,operationDigest:await recoveryOperationDigest($state.snapshot(pending.operation!))},pending.token),pending);
    secret="";go("email");await sendCode();
  }
  async function sendCode(resend=false){
    if(!pending)return;
    const result=await request("/api/v1/signup-email/start",{signupId:pending.signupId,email:pending.email,...(resend?{resend:true}:{})},pending.token);
    emailRetryAt=Date.now()+30_000;emailVerified=result.verified===true;
    if(emailVerified)go("publish");else message="We sent an eight-digit code. Check your inbox and spam folder.";
  }
  async function verifyEmail(){
    if(!pending)return;
    const result=await request("/api/v1/signup-email/verify",{signupId:pending.signupId,code},pending.token);
    if(result.verified!==true)throw new Error("Email not verified");
    code="";emailVerified=true;go("publish");
  }
  function selectAccountScreen(){
    if(summary?.state==="passkey-enrollment")go("passkey");
    else if(summary?.state==="sign-in-required")go("signin");
    else if(summary?.state==="enrollment-expired")go("expired");
  }
  async function advance(){
    if(!pending)return;
    attempts++;retryAt=Date.now()+15_000;
    const p=$state.snapshot(pending);
    summary=checkSummary(await request(`/api/v1/signup/${p.signupId}/advance`,{enrollmentToken:p.enrollmentToken,operation:p.operation},p.token),p);
    if(summary.state!=="awaiting-monitor"&&summary.state!=="preparing"){retryAt=0;selectAccountScreen();}
  }
  async function publish(){if(!emailVerified)return;go("activating");attempts=0;await advance();}
  async function checkEnrollment(){
    if(!pending)return;
    summary=checkSummary(await request(`/api/v1/signup/${pending.signupId}`,undefined,pending.token),pending);selectAccountScreen();
  }
  async function enroll(){
    if(!pending)return;
    const start=await request("/api/v1/auth/passkeys/recovery/options",{token:pending.enrollmentToken});
    const response=await startRegistration({optionsJSON:start.options});
    await request("/api/v1/auth/passkeys/recovery",{token:pending.enrollmentToken,challengeId:start.challengeId,response,label});
    await checkEnrollment();
  }
  async function finish(){
    if(!pending)return;
    await checkEnrollment();if(summary?.state!=="sign-in-required")return;
    const start=await request("/api/v1/auth/passkeys/authentication/options",{});
    const response=await startAuthentication({optionsJSON:start.options});
    await request("/api/v1/auth/passkeys/authentication",{challengeId:start.challengeId,response});
    const result=await request(`/api/v1/signup/${pending.signupId}/complete`,{});
    if(result.state!=="complete"||result.signupId!==pending.signupId)throw new Error("Not complete");
    localStorage.removeItem(PENDING_STORAGE);clearMemory();cached=false;go("done");
  }
  async function restore(){
    const text=file?(file.size<=98_304?await file.text():""):localStorage.getItem(PENDING_STORAGE);
    if(!text)throw new Error("Choose your recovery package");
    const current=epoch,secretText=enteredSecret.trim(),fromPackage=JSON.parse(text)?.type==="hail.recovery-package";
    const restored=fromPackage?await openRecoveryPackage(text,secretText,data.policy):
      {key:await pendingKey(secretText),pending:await openPending(text,await pendingKey(secretText),data.policy)};
    if(current!==epoch)throw new Error("Setup page closed");
    pending=restored.pending;key=restored.key;await persist();summary=null;
    try{summary=checkSummary(await request(`/api/v1/signup/${pending.signupId}`,undefined,pending.token),pending);}
    catch(error){if(!(error instanceof SignupRequestError&&[401,404].includes(error.status)))throw error;}
    // An older unsigned file may predate a successful publication. Recover the
    // exact retained signature; never sign a replacement for that identity.
    if(summary?.operation&&!pending.operation){pending.operation=summary.operation;pending.did=summary.did;await persist();}
    if(summary?.state==="awaiting-monitor"&&!pending.operation)throw new Error("Original signed identity is unavailable");
    const raw=decodeBase64Url(secretText,32);try{await prepareAndSign(raw);}finally{raw.fill(0);}
    if(fromPackage&&summary?.state==="recovery-required"){
      summary=checkSummary(await request(`/api/v1/signup/${pending.signupId}/verify-backup`,{backupVerified:true,operationDigest:await recoveryOperationDigest($state.snapshot(pending.operation!))},pending.token),pending);
    }
    if(["passkey-enrollment","sign-in-required","enrollment-expired"].includes(summary?.state??"")){selectAccountScreen();return;}
    if(summary?.state==="awaiting-monitor"){go("activating");attempts=0;retryAt=Date.now()+1000;return;}
    if(!fromPackage&&pending.version===2&&summary?.state==="recovery-required"){go("verify");return;}
    if(!fromPackage&&pending.version===1){secret=secretText;downloaded=false;secretSaved=false;go("save");return;}
    go("email");await sendCode();
  }
</script>

<svelte:head><title>Create your account · Haili</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<div class="signup-shell">
  {#if screen!=="done"}
    <p class="signup-progress" aria-live="polite">Step {phase+1} of {phases.length} · {phases[phase]}</p>
    <ol aria-label="Signup steps" class="signup-dots">{#each phases as name,index}<li aria-current={index===phase?"step":undefined} class:current={index===phase} class:past={index<phase}><span class="sr-only">{name}</span></li>{/each}</ol>
  {/if}
  <section class="hail-card signup-card" aria-busy={busy}>
    <h1 id="signup-heading" tabindex="-1" class="hail-title">{headings[screen]}</h1>
    {#key screen}<div class="signup-page">
      {#if screen==="address"}
        <form onsubmit={e=>{e.preventDefault();void run(chooseAddress);}}>
          {#if data.signupMode==="invite"||invitation}<label>Invitation<input type="password" bind:value={invitation} required={data.signupMode==="invite"} autocomplete="off" maxlength="2048" /></label>{/if}
          <label>Your Hail address<div class="address-input"><input bind:value={local} required pattern={'[a-z0-9][a-z0-9._\\-]{0,63}'} maxlength="64" autocomplete="username" /><span>@{new URL(data.policy.provider).hostname}</span></div></label>
          <label>Security email<input type="email" bind:value={email} required autocomplete="email" maxlength="254" /></label>
          <p>Use an existing email address outside Hail for security alerts. We’ll verify it later.</p>
          <button class="hail-button" disabled={busy||now<retryAt}>Continue</button>
        </form>
        <button class="text-link" onclick={()=>go("resume")}>Continue an interrupted setup</button>
      {:else if screen==="protection"}
        <p>Hail handles everyday messaging. You keep the recovery keys that control your identity.</p>
        <ul><li>Keep an encrypted recovery file and its secret in separate places.</li><li>Your address, identity keys and service endpoint become permanently public when you create the account.</li><li>During this alpha, Hail also operates the monitor. It cannot independently protect you against Hail suppressing alerts. Recovery is time-sensitive.</li></ul>
        <details><summary>How recovery works</summary><p>Your browser temporarily handles recovery keys. Compromised page code or your device could steal them. Your recovery file and secret must stay separate. Passkeys and email alerts do not replace owner recovery, and a backup alone does not guarantee protection.</p></details>
        <label class="check"><input type="checkbox" bind:checked={consent} /> I accept managed custody, the alpha limitations and permanent publication, and will save and verify my recovery kit.</label>
        <div class="actions"><button class="hail-button-secondary" disabled={busy} onclick={()=>go("address")}>Back</button><button class="hail-button" disabled={busy||!consent||now<retryAt} onclick={()=>run(generate)}>Set up recovery</button></div>
      {:else if screen==="save"}
        <p>Save this one file. It contains your encrypted recovery keys and lets you continue an interrupted setup.</p>
        {#if packageText}<button class="hail-button" disabled={busy} onclick={download}>Download recovery kit</button>{:else}<p>Your original setup is saved in this browser. Keep the secret below while we finish preparing your kit.</p><button class="hail-button" disabled={busy||now<retryAt} onclick={()=>run(generate)}>Retry preparing recovery kit</button>{/if}
        {#if secret}<div><p>Recovery secret</p><div class="flex min-w-0 items-center gap-1"><code class="min-w-0 flex-1" data-recovery-secret>{secret}</code><CopyButton value={secret} label="Copy recovery secret" /></div></div>{/if}
        <p>Save the secret in a password manager or on paper, separately from the file. Anyone with both can unlock your recovery keys.</p>
        <label class="check"><input type="checkbox" bind:checked={secretSaved} /> I saved the secret separately.</label>
        <button class="hail-button" disabled={busy||!downloaded||!secretSaved} onclick={()=>{secret="";go("verify");}}>Continue</button>
      {:else if screen==="verify"}
        <p>Open the file you just saved and enter the secret from your separate copy. This checks that your recovery kit works.</p>
        <form onsubmit={e=>{e.preventDefault();void run(verifyPackage);}}>
          <label>Saved recovery kit<input type="file" required accept=".json,application/json" onchange={e=>file=e.currentTarget.files?.[0]??null} /></label>
          <label>Saved recovery secret<input type="password" required bind:value={enteredSecret} autocomplete="off" spellcheck="false" maxlength="43" /></label>
          <button class="hail-button" disabled={busy||now<retryAt}>Verify and continue</button>
        </form>
        <button class="text-link" onclick={download}>Download the same kit again</button>
      {:else if screen==="email"}
        <p>Enter the code sent to <strong>{pending?.email}</strong>. This email receives security alerts; it cannot reset your recovery keys.</p>
        <form onsubmit={e=>{e.preventDefault();void run(verifyEmail);}}>
          <label>Eight-digit code<input bind:value={code} required pattern={'[0-9]{8}'} inputmode="numeric" autocomplete="one-time-code" maxlength="8" /></label>
          <button class="hail-button" disabled={busy||now<retryAt}>Verify email</button>
        </form>
        <button class="text-link" disabled={busy||now<emailRetryAt||now<retryAt} onclick={()=>run(()=>sendCode(true))}>{now<emailRetryAt?`Resend in ${Math.ceil((emailRetryAt-now)/1000)}s`:"Resend code"}</button>
      {:else if screen==="publish"}
        <p class="account-address">{pending?.address}</p><p>Your recovery kit and security email are verified. Creating your account publishes its identity permanently.</p>
        <details><summary>Public identity details</summary><p>Provider: {data.policy.provider}<br />Monitor: {data.policy.monitorOrigin} (same operator)</p><pre>{JSON.stringify(pending?.operation,null,2)}</pre></details>
        <button class="hail-button" disabled={busy||now<retryAt} onclick={()=>run(publish)}>Create my account</button>
      {:else if screen==="activating"}
        <p>We’re publishing your identity, connecting monitoring and checking security-alert delivery. You don’t need to repeat these steps.</p>
        {#if attempts<maxActivationAttempts}<p role="status">This can take a few minutes. Keep this page open; we’ll continue automatically when the checks finish.</p>{:else}<p>This is taking longer than expected. Your original setup is saved; you can check again or return later with your recovery kit.</p><button class="hail-button" disabled={busy||now<retryAt} onclick={()=>{attempts=0;void run(advance);}}>Check again</button>{/if}
      {:else if screen==="passkey"}
        <p>Use your device or password manager to create a passkey for everyday sign-in.</p>
        <form onsubmit={e=>{e.preventDefault();void run(enroll);}}><label>Passkey name<input bind:value={label} required maxlength="80" /></label><button class="hail-button" disabled={busy||now<retryAt}>Create passkey</button></form>
        <button class="text-link" disabled={busy||now<retryAt} onclick={()=>run(checkEnrollment)}>Already created it? Check status</button>
      {:else if screen==="signin"}
        <p>Sign in once to confirm your passkey works and finish setup. Keep the recovery kit you already saved.</p>
        <button class="hail-button" disabled={busy||now<retryAt} onclick={()=>run(finish)}>Sign in and finish</button>
      {:else if screen==="expired"}
        <p>The passkey setup window expired. Keep your recovery kit and contact the provider to continue with this identity. Starting over would create a different identity.</p>
        <button class="hail-button-secondary" disabled={busy||now<retryAt} onclick={()=>run(checkEnrollment)}>Check passkey status</button>
        <a href="/?next=%2F">Sign in with an existing passkey</a>
      {:else if screen==="resume"}
        <p>{cached?"Encrypted setup was found in this browser. Enter your recovery secret, or choose your saved kit.":"Open your recovery kit and enter its separate secret to continue."} Older pending setup files are also accepted.</p>
        <form onsubmit={e=>{e.preventDefault();void run(restore);}}><label>Recovery kit or pending setup file<input type="file" required={!cached} accept=".json,application/json" onchange={e=>file=e.currentTarget.files?.[0]??null} /></label><label>Saved recovery secret<input type="password" required bind:value={enteredSecret} autocomplete="off" spellcheck="false" maxlength="43" /></label><button class="hail-button" disabled={busy||now<retryAt}>Continue setup</button></form>
        <p>Setup access lasts 24 hours. After that, keep your kit and contact the provider. This screen resumes signup; it does not recover an existing account.</p>
        <a href="/?next=%2F">Already finished? Sign in</a>
        {#if !cached}<button class="text-link" onclick={()=>go("address")}>Back</button>{/if}
      {:else if screen==="done"}
        <p>Keep your recovery kit and secret separately. Your temporary setup access has been retired.</p><a class="hail-button" href="/">Open your inbox</a>
      {/if}
    </div>{/key}
    {#if busy&&screen!=="activating"}<p role="status">Working…</p>{/if}
    {#if now<retryAt&&screen!=="activating"}<p>Try again in {Math.ceil((retryAt-now)/1000)} seconds.</p>{/if}
    {#if message}<p class="signup-message" role="status">{message}</p>{/if}
  </section>
</div>
<style>
  .signup-shell{max-width:600px;margin:0 auto}.signup-progress{font-size:.875rem;color:var(--color-muted);margin:0 0 12px}.signup-dots{display:flex;gap:8px;list-style:none;margin:0 0 24px;padding:0}.signup-dots li{height:5px;flex:1;border-radius:8px;background:var(--color-line)}.signup-dots li.current,.signup-dots li.past{background:var(--color-brand)}
  .signup-card{padding:32px;display:grid;gap:20px}.signup-card h1,.signup-card p{margin:0}.signup-page,.signup-page form{display:grid;gap:20px}.signup-page{animation:arrive .18s ease-out}.signup-page p,.signup-page li{font-size:.9375rem;line-height:1.6}.signup-page ul{margin:0;padding-left:20px}.signup-page li+li{margin-top:10px}.signup-page label{display:grid;gap:8px;font-size:.875rem}.signup-page input:not([type=checkbox]){width:100%;min-width:0;box-sizing:border-box;padding:12px;border:1px solid var(--color-line);border-radius:8px;font:inherit}.signup-page .check{display:flex;align-items:flex-start;line-height:1.5}.check input{margin-top:4px}.address-input{display:flex;align-items:center;gap:8px}.address-input span{white-space:nowrap}.actions{display:flex;justify-content:space-between;gap:12px}.signup-page button,.signup-page a{justify-self:start}.signup-page button:disabled{opacity:.55;cursor:not-allowed}.signup-page code{display:block;overflow-wrap:anywhere;padding:16px;background:var(--color-canvas);border-radius:8px;user-select:all}.signup-page pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.signup-page summary{cursor:pointer;font-size:.875rem}.signup-page details p{margin-top:12px}.account-address{font-weight:600;overflow-wrap:anywhere}.text-link{background:none;border:0;padding:0;color:var(--color-brand-strong);font:inherit;text-decoration:underline;cursor:pointer}.signup-message{padding:14px;border:1px solid var(--color-line);border-radius:8px;line-height:1.6;font-size:.875rem}
  @keyframes arrive{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}@media(prefers-reduced-motion:reduce){.signup-page{animation:none}}@media(max-width:540px){.signup-card{padding:20px}.address-input{flex-wrap:wrap}.address-input input{flex:1;min-width:130px}}
</style>
