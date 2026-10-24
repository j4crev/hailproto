<script lang="ts">
  import {startAuthentication} from "@simplewebauthn/browser";
  let busy=$state(false),message=$state("");
  async function json(response:Response){if(!response.ok)throw new Error("The provider refused the request.");return response.json();}
  async function login(){
    busy=true;message="";
    try{
      const start=await json(await fetch("/api/v1/auth/passkeys/authentication/options",{method:"POST"}));
      const response=await startAuthentication({optionsJSON:start.options});
      await json(await fetch("/api/v1/auth/passkeys/authentication",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({challengeId:start.challengeId,response})}));
      location.href="/";
    }catch(error){message=error instanceof Error?error.message:"Passkey sign-in failed.";}finally{busy=false;}
  }
</script>

<section class="hail-card flex max-w-[560px] flex-col items-start gap-4 p-[42px]">
  <p class="m-0 text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Provider access</p>
  <h1 class="m-0">Sign in to Hail</h1>
  <p class="m-0 leading-[1.6] text-[#657168]">Use a passkey saved on this device, another device, or a security key.</p>
  <button class="cursor-pointer rounded-[10px] border-0 bg-[#17633f] px-[18px] py-3 [font:inherit] font-[750]! text-white disabled:cursor-wait disabled:opacity-60" onclick={login} disabled={busy}>Sign in with a passkey</button>
  {#if message}<p class="m-0 text-[14px] leading-[1.6] text-[#657168]" aria-live="polite">{message}</p>{/if}
</section>
