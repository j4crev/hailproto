<script lang="ts">
  import {startAuthentication} from "@simplewebauthn/browser";
  import {onMount} from "svelte";
  import {returnPath} from "$lib/auth-routing.js";
  import Icon from "$lib/Icon.svelte";
  let {returnTo = "/"}: {returnTo?: string} = $props();
  let busy = $state(false), message = $state(""), ready = $state(false);
  onMount(() => { ready = true; });
  async function json(response: Response) {
    if (!response.ok) throw new Error("We couldn’t sign you in. Please try again.");
    return response.json();
  }
  async function login() {
    if (busy) return;
    busy = true; message = "";
    try {
      const start = await json(await fetch("/api/v1/auth/passkeys/authentication/options", {method: "POST"}));
      const response = await startAuthentication({optionsJSON: start.options});
      await json(await fetch("/api/v1/auth/passkeys/authentication", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({challengeId: start.challengeId, response})}));
      const target = new URL(returnPath(returnTo), location.origin);
      // Preserve browser-local QR fragments without submitting them to the server.
      if (location.hash) target.hash = location.hash;
      location.href = returnPath(target.pathname + target.search + target.hash);
    } catch (error) {
      message = error instanceof Error && error.name === "NotAllowedError"
        ? "Sign-in was cancelled. Try again when you’re ready."
        : error instanceof Error ? error.message : "Passkey sign-in failed. Please try again.";
    } finally { busy = false; }
  }
</script>
<div class="grid gap-4">
  <button class="hail-button" onclick={login} disabled={busy || !ready} aria-busy={busy}><Icon name="key" />{busy ? "Waiting for your passkey…" : "Sign in with a passkey"}<Icon name="arrow" size={18} /></button>
  <noscript><p class="hail-error">Enable JavaScript to sign in with a passkey.</p></noscript>
  {#if message}<p class="hail-error" role="alert">{message}</p>{/if}
</div>
