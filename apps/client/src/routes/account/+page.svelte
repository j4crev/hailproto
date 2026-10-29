<script lang="ts">
  let {data} = $props();
  let copied = $state(false), copyError = $state("");
  async function copyAddress() {
    try { await navigator.clipboard.writeText(data.account.address); copied = true; copyError = ""; }
    catch { copyError = "Couldn’t copy. Select and copy your address below."; }
  }
</script>
<svelte:head><title>Account · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Account</h1></header>
  <section class="hail-card overflow-hidden" aria-label="Account details">
    <div class="account-banner"><span class="account-avatar">{data.account.address.split('@')[0].slice(0,2).toUpperCase()}</span><span class="text-xs font-semibold text-brand-strong">Your Hail identity</span></div>
    <div class="grid gap-7 p-6 sm:p-8">
      <div class="flex flex-wrap items-center justify-between gap-4"><div class="min-w-0"><p class="hail-eyebrow mb-2">Hail address</p><h2 class="m-0 text-xl tracking-tight [overflow-wrap:anywhere]">{data.account.address}</h2></div><button class="hail-button-secondary" onclick={copyAddress}>{copied ? 'Copied' : 'Copy address'}</button><span class="sr-only" role="status">{copied ? 'Address copied to clipboard.' : ''}</span></div>
      {#if copyError}<p class="hail-error" role="status">{copyError}</p>{/if}
      <dl class="m-0 grid gap-6 border-0 border-t border-solid border-line pt-6"><div><dt class="text-sm font-semibold">Identity</dt><dd class="m-0 mt-2 font-mono text-xs text-muted [overflow-wrap:anywhere]">{data.account.did}</dd></div><div><dt class="text-sm font-semibold">Key custody</dt><dd class="m-0 mt-2 text-sm text-muted">{data.account.custodyProfile === 'managed' ? 'Provider managed' : data.account.custodyProfile === 'owner-controlled' ? 'Owner controlled' : data.account.custodyProfile}</dd></div></dl>
    </div>
  </section>
</div>
<style>
  .account-banner { height:140px; padding:24px 32px; display:flex; align-items:center; justify-content:space-between; gap:16px; background:var(--color-brand-soft); background-image:radial-gradient(circle at 85% 140%, transparent 80px, #0f766e0b 81px, #0f766e0b 120px, transparent 121px); }
  .account-avatar { display:grid; place-items:center; width:72px; height:72px; flex-shrink:0; border:5px solid var(--color-surface); border-radius:50%; background:var(--color-brand); color:var(--color-on-brand); font-size:24px; font-weight:650; }
</style>
