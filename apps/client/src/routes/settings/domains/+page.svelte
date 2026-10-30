<script lang="ts">
  import CopyButton from "$lib/CopyButton.svelte";
  import { PENDING_STORAGE } from "$lib/signup.js";
  import { invalidateAll } from "$app/navigation";
  let { data } = $props();
  let domain = $state(""), busy = $state(false), message = $state("");
  let localParts = $state<Record<string,string>>({});
  let challenge = $state<{ id: string; value: string } | null>(null);
  async function request(path: string, body: unknown) {
    const response = await fetch(`/api/v1/account/custom-domains${path}`, {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Domain operation failed. Try again.");
    return result;
  }
  async function run(operation: () => Promise<void>) {
    busy = true; message = "";
    try { await operation(); await invalidateAll(); }
    catch (error) { message = error instanceof Error ? error.message : "Unable to update domain."; }
    finally { busy = false; }
  }
  async function start(name: string) {
    await run(async () => {
      const result = await request("", { domain: name });
      challenge = result.verificationValue ? { id: result.id, value: result.verificationValue } : null;
      domain = "";
      message = result.verificationValue ? "Add both TXT records, then check DNS. Keep this page open to retain the challenge value." : "Domain is already registered.";
    });
  }
  async function verify(id: string) {
    await run(async () => {
      const result = await request(`/${id}/verify`, {});
      message = result.status === "verified" ? "Domain registered." :
        `Ownership ${result.ownership ? "confirmed" : "not yet confirmed"}; provider routing ${result.delegation ? "confirmed" : "not yet confirmed"}. Check the records and retry after one minute.`;
      if (result.status === "verified") challenge = null;
    });
  }
  async function createAccount(id:string,domain:string){
    await run(async()=>{
      if(localStorage.getItem(PENDING_STORAGE))throw new Error("Continue your unfinished setup at /signup before starting another account.");
      const result=await request(`/${id}/authorize-address`,{address:`${localParts[id]}@${domain}`});
      // Fragments stay out of HTTP requests; signup removes it immediately.
      location.assign(`/signup#${new URLSearchParams({address:result.address,addressAuthorization:result.token})}`);
    });
  }
</script>

<svelte:head><title>Custom domains · Haili</title></svelte:head>
<div class="mx-auto grid max-w-[860px] gap-6">
  <header class="page-heading"><a href="/settings">Settings</a><h1 class="hail-title">Custom domains</h1></header>
  <section class="hail-card grid gap-4 p-6 sm:p-8">
    <p class="m-0">Register a domain you control with {data.provider}. Each custom address creates a separate account with its own inbox, recovery file, and login.</p>
    <form class="grid gap-3" onsubmit={event => { event.preventDefault(); void start(domain); }}>
      <label class="hail-field"><span>Domain name</span><input bind:value={domain} placeholder="example.com" required maxlength="253" disabled={busy} /></label>
      <button class="hail-button" disabled={busy || !domain}>Add domain</button>
    </form>
    <p class="m-0 text-sm text-muted">Verification is checked on request, not monitored continuously.</p>
    {#if message}<p role="status" class="m-0">{message}</p>{/if}
  </section>
  {#each data.domains as item (item.id)}
    <section class="hail-card grid gap-4 p-6 sm:p-8" aria-label={item.domain}>
      <h2 class="m-0 text-lg">{item.domain}</h2>
      {#if item.lastVerifiedAt}
        <p class="m-0">Registered · Last verified {new Date(item.lastVerifiedAt).toLocaleString()}</p>
        <p class="m-0 text-sm text-muted">You can remove the ownership verification TXT record named <code class="break-all">{item.verificationName}</code>. Keep the provider routing TXT record named <code class="break-all">{item.delegationName}</code>. Domain removal and ownership transfer are not available yet.</p>
        {#if data.signupAvailable}
          <form class="grid gap-3" onsubmit={event=>{event.preventDefault();void createAccount(item.id,item.domain);}}>
            <label class="hail-field"><span>New address at @{item.domain}</span><input bind:value={localParts[item.id]} required pattern={'[a-z0-9][a-z0-9._\\-]{0,63}'} maxlength="64" disabled={busy} /></label>
            <p class="m-0 text-sm text-muted">Continue setup within 15 minutes. No separate signup invitation is needed for this address. Signing in to the new account will switch your current session.</p>
            <button class="hail-button" disabled={busy}>Create separate account</button>
          </form>
        {/if}
      {:else}
        <p class="m-0">{item.status === "expired" ? "Challenge expired" : "Awaiting DNS verification"}</p>
        <div class="grid gap-2 text-sm">
          <strong>Ownership · TXT</strong>
          <dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <dt>Name:</dt>
            <dd class="m-0 flex min-w-0 items-center gap-2"><code class="min-w-0 break-all select-all">{item.verificationName}</code><CopyButton value={item.verificationName} label="Copy ownership record name" /></dd>
            {#if challenge?.id === item.id}
              <dt>Value:</dt>
              <dd class="m-0 flex min-w-0 items-center gap-2"><code class="min-w-0 break-all select-all">{challenge.value}</code><CopyButton value={challenge.value} label="Copy ownership record value" /></dd>
            {/if}
          </dl>
          {#if challenge?.id === item.id}<span>Expires {new Date(item.challengeExpiresAt).toLocaleString()}</span>
          {:else}<p class="m-0">If you already added the challenge, check DNS. Otherwise generate a new challenge; it replaces the previous value.</p>{/if}
        </div>
        <div class="flex flex-wrap gap-3">
          <button class="hail-button" disabled={busy || item.status === "expired"} onclick={() => verify(item.id)}>Check DNS</button>
          <button class="hail-button-secondary" disabled={busy} onclick={() => start(item.domain)}>New challenge</button>
          <button class="hail-button-secondary" disabled={busy} onclick={() => run(async () => { await request(`/${item.id}/remove`, {}); if (challenge?.id === item.id) challenge = null; })}>Remove pending domain</button>
        </div>
      {/if}
      <div class="grid gap-2 text-sm">
        <strong>Provider routing · TXT</strong>
        <dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <dt>Name:</dt>
          <dd class="m-0 flex min-w-0 items-center gap-2"><code class="min-w-0 break-all select-all">{item.delegationName}</code><CopyButton value={item.delegationName} label="Copy routing record name" /></dd>
          <dt>Value:</dt>
          <dd class="m-0 flex min-w-0 items-center gap-2"><code class="min-w-0 break-all select-all">{item.delegationValue}</code><CopyButton value={item.delegationValue} label="Copy routing record value" /></dd>
        </dl>
      </div>
    </section>
  {/each}
</div>
