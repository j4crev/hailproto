<script lang="ts">
  import {onMount, untrack} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  import {profileDraft, type Category} from "$lib/sender-profile.js";
  import {senderLink, senderQr} from "$lib/permissions.js";
  let {data} = $props();
  let name = $state(untrack(() => data.definition.display_name));
  let description = $state(untrack(() => data.definition.description ?? ""));
  let categories = $state<(Category & {persistedId?: string})[]>(untrack(() => data.definition.categories.filter(category => category.id !== "general").map(category => ({...category, persistedId: data.revision ? category.id : undefined}))));
  let busy = $state(false), ready = $state(false), message = $state(""), conflict = $state(false), showQr = $state(false), copied = $state("");
  const share = $derived(senderLink(data.origin, data.account.address, data.account.did));
  const qr = $derived(showQr && share ? senderQr(share) : null);
  onMount(() => {ready = true;});
  async function json(response: Response) {
    if (!response.ok) throw new Error("Passkey verification failed. Please try again.");
    return response.json();
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    message = ""; conflict = false;
    let definition;
    try {definition = profileDraft(data.definition, name, description, categories);}
    catch (error) {message = error instanceof Error ? error.message : "Check your profile."; return;}
    busy = true;
    try {
      const start = await json(await fetch("/api/v1/auth/passkeys/authentication/options", {method: "POST"}));
      const response = await startAuthentication({optionsJSON: start.options});
      await json(await fetch("/api/v1/auth/passkeys/authentication", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({challengeId: start.challengeId, response})}));
      const account = await json(await fetch("/api/v1/account", {cache: "no-store"}));
      if (account.did !== data.account.did) throw new Error("You verified a different account. Sign in to the original account before saving this draft.");
      const saved = await fetch("/api/v1/account/profile", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({definition, expectedRevision: data.revision})});
      if (!saved.ok) {
        conflict = saved.status === 409;
        throw new Error(conflict ? "Your profile changed or your account is moving. Reload the latest version before editing again."
          : saved.status === 403 ? "Profile updates aren’t available for this session. Sign in again and retry."
          : saved.status === 400 ? "The provider rejected this profile. Check your names, descriptions and category IDs."
          : "Saving wasn’t confirmed. Your draft is still here; retry to check or save the same revision.");
      }
      location.reload();
    } catch (error) {message = error instanceof Error ? error.message : "Couldn’t save your profile. Please try again."; busy = false;}
  }
  function reload() {if (confirm("Discard your draft and load the latest profile?")) location.reload();}
  async function copy() {
    try {await navigator.clipboard.writeText(share); copied = "Link copied.";}
    catch {copied = "Couldn’t copy. Select the link below to copy it.";}
  }
</script>
<svelte:head><title>Categories · Haili</title></svelte:head>
<header class="page-heading"><h1 class="hail-title">Categories</h1><p>{data.revision ? 'Manage what people can subscribe to.' : 'Create a sender profile to let people subscribe to your updates.'}</p></header>
<div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
  <form class="hail-card min-w-0 p-5 sm:p-7" onsubmit={save}>
    <fieldset class="m-0 grid min-w-0 gap-6 border-0 p-0" disabled={busy || !ready || !!data.account.migrationState}>
      <div class="grid gap-2"><h2 class="m-0 text-xl">{data.revision ? 'Sender profile' : 'Start publishing'}</h2><p class="m-0 text-sm text-muted">Your name, description, and categories are public.</p></div>
      <label class="hail-field">Sender name<input bind:value={name} maxlength="128" required autocomplete="off" placeholder="Your name or publication" /></label>
      <label class="hail-field">Description (optional)<input bind:value={description} maxlength="1024" /></label>
      <section class="grid min-w-0 gap-4" aria-label="Publishing categories">
        <h2 class="m-0 text-lg">Your categories</h2>
        <div class="grid gap-2 rounded-xl border border-solid border-line bg-canvas p-4" aria-label="General category">
          <div class="flex items-center justify-between gap-3"><strong>General</strong><span class="text-xs text-muted">Built-in · Fixed</span></div>
          {#if data.revision && !data.definition.categories.some(category => category.id === 'general')}<p class="m-0 text-xs text-muted">Added to your profile when you save.</p>{/if}
        </div>
        {#each categories as category, index}
          <div class="grid min-w-0 gap-4 rounded-xl border border-solid border-line p-4">
            <div class="flex items-center justify-between gap-3"><strong class="text-sm">Category {index + 1}</strong><button class="hail-button-secondary text-danger" type="button" onclick={() => {categories = categories.filter((_, i) => i !== index);}} aria-label={`Remove category ${index + 1}`}>Remove</button></div>
            <div class="grid items-start gap-4 sm:grid-cols-2">
            <label class="hail-field">Category name<input bind:value={category.label} maxlength="128" required placeholder="News, events, or new releases" /></label>
            <label class="hail-field">Category ID<input bind:value={category.id} readonly={!!category.persistedId} maxlength="64" pattern={"(?!general$)[a-z0-9][a-z0-9._\\-]{0,63}"} required placeholder="news" /><span class="text-xs font-normal text-muted">{category.persistedId ? 'This ID stays fixed for existing subscriptions.' : 'A permanent ID, such as news or events. Use lowercase letters, numbers, dots, hyphens or underscores. General is reserved.'}</span></label>
            </div>
            <label class="hail-field">Category description (optional)<input bind:value={category.description} maxlength="1024" /></label>
          </div>
        {/each}
        {#if !categories.length}<p class="m-0 text-sm text-muted">Add custom categories for specific topics.</p>{/if}
        <button class="hail-button-secondary justify-self-start" type="button" disabled={categories.length >= 99} onclick={() => {categories = [...categories, {id: '', label: ''}];}}>Add category</button>
        <p class="m-0 text-xs text-muted">Removing a custom category does not revoke existing subscriptions.</p>
      </section>
      <button class="hail-button justify-self-start" disabled={conflict}>{busy ? 'Saving…' : data.revision ? 'Save changes with passkey' : 'Create sender profile with passkey'}</button>
    </fieldset>
    {#if data.account.migrationState}<p class="hail-error mt-4">Profile editing is paused while your account moves.</p>{/if}
    {#if message}<p class="hail-error mt-4" role="alert">{message}</p>{/if}
    {#if conflict}<button class="hail-button-secondary mt-4" type="button" onclick={reload}>Reload latest profile</button>{/if}
  </form>
  <aside class="hail-card grid min-w-0 gap-4 p-5 sm:p-7">
    <h2 class="m-0 text-xl">Share your sender QR</h2>
    {#if data.revision}
      <p class="m-0 text-sm text-muted">Invite people to subscribe. They choose which categories to receive.</p>
      <button class="hail-button-secondary justify-self-start" onclick={() => {showQr = !showQr;}} aria-expanded={showQr} aria-controls="sender-qr">{showQr ? 'Hide QR' : 'Show my sender QR'}</button>
      {#if qr}<div id="sender-qr"><svg class="h-auto max-w-full" viewBox={`0 0 ${qr.size} ${qr.size}`} width="256" height="256" role="img" aria-label={`Sender request QR for ${data.account.address}`} shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white" /><path d={qr.path} fill="black" /></svg></div>{/if}
      <label class="hail-field">Subscription link<input readonly value={share} onclick={event => event.currentTarget.select()} /></label>
      <button class="hail-button-secondary justify-self-start" onclick={copy}>Copy link</button>
      <p class="m-0 text-xs text-muted" role="status">{copied}</p>
    {:else}<p class="m-0 text-sm text-muted">Create your sender profile to get a subscription link and QR code.</p>{/if}
  </aside>
</div>
