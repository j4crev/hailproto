<script lang="ts">
  import {onMount} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  import {APPROVAL_STORAGE, approval, permissionRequest, subscriptionScopeLabel, type Approval} from "$lib/permissions.js";
  import type {senderSubscription} from "$lib/server/subscription.js";
  let {subscription, owner}: {subscription: NonNullable<Awaited<ReturnType<typeof senderSubscription>>>; owner: string} = $props();
  let prepared = $state<Approval | null>(null), requestId = $state<string | null>(null);
  let busy = $state(false), ready = $state(false), done = $state(false), error = $state(""), now = $state(Date.now());
  onMount(() => {ready = true; const timer = setInterval(() => {now = Date.now();}, 1000); return () => clearInterval(timer);});
  function retain(value: unknown) {
    const review = approval(value);
    if (review.permissions || review.action !== "revoke" || review.requestId !== requestId || review.permission.grant_id !== subscription.grantId ||
      review.permission.grantor !== owner || review.permission.grantee !== subscription.did ||
      review.result && (!("grantId" in review.result) || review.result.grantId !== subscription.grantId || review.result.status !== "revoked")) throw new Error("The unsubscribe review does not match this sender.");
    prepared = review;
    if (review.result) {
      done = true;
      try {if (sessionStorage.getItem(APPROVAL_STORAGE) === requestId) sessionStorage.removeItem(APPROVAL_STORAGE);} catch {}
    }
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true; error = "";
    try {await action();} catch (cause) {error = cause instanceof Error ? cause.message : "Couldn’t confirm your unsubscribe. Check its status before retrying.";}
    finally {busy = false;}
  }
  async function prepare() {
    requestId ??= crypto.randomUUID();
    try {sessionStorage.setItem(APPROVAL_STORAGE, requestId);} catch {}
    retain(await permissionRequest("prepare", {requestId, action: "revoke", grantId: subscription.grantId, revision: subscription.revision, digest: subscription.digest}));
  }
  async function confirm() {
    if (!prepared) return;
    const response = prepared.approved ? undefined : await startAuthentication({optionsJSON: prepared.options!});
    retain(await permissionRequest("commit", {requestId, ...(response ? {response} : {})}));
    if (!done) throw new Error("Unsubscribe not yet confirmed. Check its status before retrying.");
  }
  async function check() {if (requestId) retain(await permissionRequest(requestId));}
  function cancel() {
    if (prepared?.approved) return;
    try {if (sessionStorage.getItem(APPROVAL_STORAGE) === requestId) sessionStorage.removeItem(APPROVAL_STORAGE);} catch {}
    prepared = null; requestId = null; error = "";
  }
</script>
{#if done}
  <p class="rounded-xl bg-brand-soft p-4 text-sm [overflow-wrap:anywhere]" role="status">Unsubscribed from {subscription.sender}. Your past messages are kept. Your connections are unchanged.</p>
{:else if prepared}
  <section class="hail-card grid min-w-0 gap-4 border-brand p-5 [overflow-wrap:anywhere] sm:p-7" aria-label="Unsubscribe confirmation">
    <h2 class="m-0 text-xl">Unsubscribe from {prepared.permission.consent_context.grantee_address}?</h2>
    <p class="m-0 text-sm">This ends your subscription to all these categories: <strong>{subscriptionScopeLabel(prepared.permission.scope[0])}</strong>.</p>
    <p class="m-0 text-sm text-muted">Your past messages and connections will stay.</p>
    <details class="text-xs text-muted"><summary class="cursor-pointer py-2">Sender identity</summary><code class="[overflow-wrap:anywhere]">{prepared.permission.grantee}</code></details>
    <div class="flex flex-wrap gap-3">
      <button class="hail-button" disabled={busy || now >= Date.parse(prepared.expiresAt)} onclick={() => run(confirm)}>{prepared.approved ? 'Retry unsubscribe' : 'Unsubscribe with my passkey'}</button>
      <button class="hail-button-secondary" disabled={busy} onclick={() => run(check)}>Check unsubscribe status</button>
      {#if !prepared.approved}<button class="hail-button-secondary" disabled={busy} onclick={cancel}>Cancel</button>{/if}
    </div>
    {#if now >= Date.parse(prepared.expiresAt)}<p class="m-0 text-sm text-muted">This approval expired. Check its status, then reload the message before starting again.</p>{/if}
  </section>
{:else}
  <button class="hail-button-secondary" disabled={busy || !ready} onclick={() => run(prepare)}>{busy ? 'Checking subscription…' : 'Unsubscribe'}</button>
  {#if requestId}<button class="hail-button-secondary ml-2" disabled={busy} onclick={() => run(check)}>Check unsubscribe status</button>{/if}
{/if}
{#if error}<p class="hail-error mt-4" role="alert">{error}</p>{/if}
