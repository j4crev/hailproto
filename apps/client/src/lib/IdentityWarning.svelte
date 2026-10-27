<script lang="ts">
  let {address,did,previousDids}:{address:string;did:string;previousDids:string[]}=$props();
</script>
{#if previousDids.length}
  <div class="rounded-xl bg-warning-soft p-4 text-sm text-warning" role="alert">
    <strong>Different identity at a familiar address</strong>
    <p class="mt-2">You previously knew {address} under a different Hail identity. A provider move preserves the identity; this change may be address reassignment or impersonation. Check with the person through a trusted channel before approving.</p>
    <p class="mt-2">This creates permission for the identity below. It does not transfer your existing conversations or subscriptions.</p>
    <details class="mt-2"><summary class="cursor-pointer">Compare identities</summary><p class="[overflow-wrap:anywhere]">New: <code>{did}</code></p>{#each previousDids as previous}<p class="[overflow-wrap:anywhere]">Previously known: <code>{previous}</code></p>{/each}</details>
  </div>
{/if}
