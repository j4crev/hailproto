<script lang="ts">
  import {onMount} from "svelte";
  import {startRegistration} from "@simplewebauthn/browser";
  let token=$state(""),label=$state("Replacement passkey"),busy=$state(false),complete=$state(false),message=$state("");
  onMount(()=>{const value=new URLSearchParams(location.hash.slice(1)).get("token")??"";
    if(/^hailp_[A-Za-z0-9_-]{43}$/.test(value)){token=value;history.replaceState(null,"",location.pathname);}else message="This recovery link is invalid or incomplete.";});
  async function json(response:Response){if(!response.ok)throw new Error("Recovery enrollment was refused or expired.");return response.json();}
  async function enroll(){
    busy=true;message="";
    try{
      const start=await json(await fetch("/api/v1/auth/passkeys/recovery/options",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token})}));
      const response=await startRegistration({optionsJSON:start.options});
      await json(await fetch("/api/v1/auth/passkeys/recovery",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({token,challengeId:start.challengeId,response,label})}));
      token="";complete=true;message="Replacement passkey created. You can sign in now.";
    }catch(error){message=error instanceof Error?error.message:"Recovery enrollment failed.";}finally{busy=false;}
  }
</script>

<svelte:head><title>Replacement passkey · Haili</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<section class="hail-card mx-auto mt-6 flex max-w-[600px] flex-col items-start gap-5 p-6 sm:p-10">
  <p class="hail-eyebrow">Owner-authorized enrollment</p><h1 class="hail-title">Create a replacement passkey</h1>
  <p class="m-0 text-sm text-muted">Use a recovery enrollment link issued after proof of existing Hail owner authority. This page does not import a recovery backup, change custody or publish a PLC operation.</p>
  {#if !complete}<label class="hail-field w-full">Passkey label<input bind:value={label} maxlength="80" /></label>
    <button class="hail-button max-w-full whitespace-normal" onclick={enroll} disabled={busy||!token||!label.trim()}>Create replacement passkey</button>
  {:else}<a class="hail-button" href="/?next=%2F">Sign in with the new passkey</a>{/if}
  {#if message}<p class="m-0 rounded-xl bg-canvas p-4 text-sm text-muted" aria-live="polite">{message}</p>{/if}
</section>
