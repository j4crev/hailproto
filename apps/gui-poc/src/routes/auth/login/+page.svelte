<script lang="ts">
  import {startAuthentication} from "@simplewebauthn/browser";
  import {onMount} from "svelte";
  import {returnPath} from "$lib/auth-routing.js";
  let {data}=$props();
  let busy=$state(false),message=$state("");
  let ready=$state(false);
  onMount(()=>{ready=true;});
  async function json(response:Response){if(!response.ok)throw new Error("The provider refused the request.");return response.json();}
  async function login(){
    busy=true;message="";
    try{
      const start=await json(await fetch("/api/v1/auth/passkeys/authentication/options",{method:"POST"}));
      const response=await startAuthentication({optionsJSON:start.options});
      await json(await fetch("/api/v1/auth/passkeys/authentication",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({challengeId:start.challengeId,response})}));
      const target=new URL(data.returnTo,location.origin);
      // HTTP redirects retain the original QR fragment; it never goes to the server.
      if(location.hash)target.hash=location.hash;
      location.href=returnPath(target.pathname+target.search+target.hash);
    }catch(error){message=error instanceof Error?error.message:"Passkey sign-in failed.";}finally{busy=false;}
  }
</script>

<svelte:head><title>Sign in · Haili</title></svelte:head>
<section class="hail-card mx-auto mt-8 flex max-w-[560px] flex-col items-start gap-5 p-8 sm:p-12">
  <p class="hail-eyebrow">Welcome back</p>
  <h1 class="hail-title">Sign in to Haili</h1>
  {#if data.returnTo!=="/"}<p class="m-0 rounded-xl bg-brand-soft p-3 text-sm text-brand-strong">Sign in to continue to your inbox. No pending action will be performed automatically.</p>{/if}
  <button class="hail-button" onclick={login} disabled={busy||!ready}>{busy?"Waiting for your passkey…":"Sign in with a passkey"}</button>
  {#if message}<p class="hail-error" role="alert">{message}</p>{/if}
</section>
