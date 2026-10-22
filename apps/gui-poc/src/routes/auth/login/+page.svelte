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

<section class="card login">
  <p class="eyebrow">Provider access</p>
  <h1>Sign in to Hail</h1>
  <p>Use a passkey saved on this device, another device, or a security key.</p>
  <button onclick={login} disabled={busy}>Sign in with a passkey</button>
  {#if message}<p class="status" aria-live="polite">{message}</p>{/if}
</section>

<style>
  .login{display:flex;max-width:560px;flex-direction:column;align-items:flex-start;gap:16px;padding:42px}.eyebrow{margin:0;color:#22714b;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1,p{margin:0}.login>p:not(.eyebrow){color:#657168;line-height:1.6}button{padding:12px 18px;border:0;border-radius:10px;background:#17633f;color:white;font:inherit;font-weight:750;cursor:pointer}button:disabled{cursor:wait;opacity:.6}.status{font-size:14px}
</style>
