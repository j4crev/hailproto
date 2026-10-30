<script lang="ts">
  import CopyButton from "$lib/CopyButton.svelte";
  let {setup}:{setup:{address:string;verificationName:string;verificationValue:string;delegationName:string;delegationValue:string;expiresAt:string}}=$props();
</script>
<div class="grid gap-4">
      <p class="m-0">Your Hail address: <strong>{setup.address}</strong></p>
      <p class="m-0">Add these two TXT records at your DNS provider. Some providers require only the part before your domain in the Name field.</p>
      {#each [{title:"Ownership",name:setup.verificationName,value:setup.verificationValue},{title:"Provider routing",name:setup.delegationName,value:setup.delegationValue}] as record}
        <div class="grid gap-2 text-sm">
          <strong>{record.title} · TXT</strong>
          <dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <dt>Name:</dt><dd class="m-0 flex min-w-0 items-center gap-2"><code class="min-w-0 break-all select-all">{record.name}</code><CopyButton value={record.name} label={`Copy ${record.title.toLowerCase()} record name`} /></dd>
            <dt>Value:</dt><dd class="m-0 flex min-w-0 items-center gap-2"><code class="min-w-0 break-all select-all">{record.value}</code><CopyButton value={record.value} label={`Copy ${record.title.toLowerCase()} record value`} /></dd>
          </dl>
        </div>
      {/each}
      <p class="m-0 text-sm text-muted">Keep both records until your account setup begins. Keep the provider routing record permanently. This DNS setup expires {new Date(setup.expiresAt).toLocaleString()}; keep this tab open while updating DNS.</p>
      <p class="m-0">After creating your account, manage this domain from Settings → Custom domains. Your account has its own inbox, recovery file, and passkey login.</p>

</div>
