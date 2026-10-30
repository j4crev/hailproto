<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  let { data } = $props();
  let domain = $state(""), busy = $state(false), message = $state("");
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
      message = result.status === "verified" ? "Domain registered. Custom-address account creation is coming in a later release." :
        `Ownership ${result.ownership ? "confirmed" : "not yet confirmed"}; provider routing ${result.delegation ? "confirmed" : "not yet confirmed"}. Check the records and retry after one minute.`;
      if (result.status === "verified") challenge = null;
    });
  }
</script>

<svelte:head><title>Custom domains · Haili</title></svelte:head>
<div class="mx-auto grid max-w-[860px] gap-6">
  <header class="page-heading"><a href="/settings">Settings</a><h1 class="hail-title">Custom domains</h1></header>
  <section class="hail-card grid gap-4 p-6 sm:p-8">
    <p class="m-0">Register a domain you control with {data.provider}. Domain registration is available now; creating separate accounts at that domain will follow in a later release.</p>
    <form class="grid gap-3" onsubmit={event => { event.preventDefault(); void start(domain); }}>
      <label class="hail-field"><span>Domain name</span><input bind:value={domain} placeholder="example.com" required maxlength="253" disabled={busy} /></label>
      <button class="hail-button" disabled={busy || !domain}>Add domain</button>
    </form>
    <p class="m-0 text-sm text-muted">DNS records leave your website and email routing unchanged. Verification is checked on request, not monitored continuously.</p>
    {#if message}<p role="status" class="m-0">{message}</p>{/if}
  </section>
  {#each data.domains as item (item.id)}
    <section class="hail-card grid gap-4 p-6 sm:p-8" aria-label={item.domain}>
      <h2 class="m-0 text-lg">{item.domain}</h2>
      {#if item.lastVerifiedAt}
        <p class="m-0">Registered · Last verified {new Date(item.lastVerifiedAt).toLocaleString()}</p>
        <p class="m-0 text-sm text-muted">Keep the provider routing record in DNS. The verification challenge has been consumed and may be removed. Domain removal and ownership transfer are not available yet.</p>
      {:else}
        <p class="m-0">{item.status === "expired" ? "Challenge expired" : "Awaiting DNS verification"}</p>
        <div class="grid gap-2 text-sm"><strong>Ownership · TXT</strong><code class="break-all">{item.verificationName}</code>
          {#if challenge?.id === item.id}<code class="break-all select-all">{challenge.value}</code><span>Expires {new Date(item.challengeExpiresAt).toLocaleString()}</span>
          {:else}<p class="m-0">If you already added the challenge, check DNS. Otherwise generate a new challenge; it replaces the previous value.</p>{/if}
        </div>
        <div class="flex flex-wrap gap-3">
          <button class="hail-button" disabled={busy || item.status === "expired"} onclick={() => verify(item.id)}>Check DNS</button>
          <button class="hail-button-secondary" disabled={busy} onclick={() => start(item.domain)}>New challenge</button>
          <button class="hail-button-secondary" disabled={busy} onclick={() => run(async () => { await request(`/${item.id}/remove`, {}); if (challenge?.id === item.id) challenge = null; })}>Remove pending domain</button>
        </div>
      {/if}
      <div class="grid gap-2 text-sm"><strong>Provider routing · TXT</strong><code class="break-all">{item.delegationName}</code><code class="break-all select-all">{item.delegationValue}</code></div>
    </section>
  {/each}
</div>
