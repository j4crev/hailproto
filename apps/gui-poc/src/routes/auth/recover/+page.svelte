<script lang="ts">
  import {onMount} from "svelte";
  import {startRegistration} from "@simplewebauthn/browser";
  let token=$state(""),label=$state("Recovery passkey"),busy=$state(false),complete=$state(false),message=$state("");
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

<section class="card recovery"><p class="eyebrow">Owner recovery</p><h1>Create a replacement passkey</h1>
  <p>This link proves existing Hail owner authority. It does not change custody or publish a PLC operation.</p>
  {#if !complete}<label>Passkey label <input bind:value={label} maxlength="80" /></label>
    <button onclick={enroll} disabled={busy||!token||!label.trim()}>Create replacement passkey</button>
  {:else}<a href="/auth/login">Sign in with the new passkey</a>{/if}
  {#if message}<p class="status" aria-live="polite">{message}</p>{/if}
</section>

<style>
  .recovery{display:flex;max-width:600px;flex-direction:column;align-items:flex-start;gap:16px;padding:42px}.eyebrow{margin:0;color:#22714b;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1,p{margin:0}.recovery>p:not(.eyebrow){color:#657168;line-height:1.6}label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:700}input{min-width:280px;padding:10px;border:1px solid #cad4cd;border-radius:8px;font:inherit}button,a{padding:11px 15px;border:0;border-radius:9px;background:#17633f;color:white;font:inherit;font-weight:750;text-decoration:none}button:disabled{opacity:.5}.status{font-size:14px}
</style>
