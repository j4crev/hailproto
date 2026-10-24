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

<section class="hail-card flex max-w-[600px] flex-col items-start gap-4 p-[42px]">
  <p class="m-0 text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Owner recovery</p><h1 class="m-0">Create a replacement passkey</h1>
  <p class="m-0 leading-[1.6] text-[#657168]">This link proves existing Hail owner authority. It does not change custody or publish a PLC operation.</p>
  {#if !complete}<label class="flex flex-col gap-1.5 text-[13px] font-bold">Passkey label <input class="min-w-[280px] rounded-lg border border-solid border-[#cad4cd] p-2.5 [font:inherit]" bind:value={label} maxlength="80" /></label>
    <button class="rounded-[9px] border-0 bg-[#17633f] px-[15px] py-[11px] [font:inherit] font-[750]! text-white disabled:opacity-50" onclick={enroll} disabled={busy||!token||!label.trim()}>Create replacement passkey</button>
  {:else}<a class="rounded-[9px] border-0 bg-[#17633f] px-[15px] py-[11px] [font:inherit] font-[750]! text-white no-underline" href="/auth/login">Sign in with the new passkey</a>{/if}
  {#if message}<p class="m-0 text-[14px] leading-[1.6] text-[#657168]" aria-live="polite">{message}</p>{/if}
</section>
