<script lang="ts">
  import ConnectionCodes from "$lib/ConnectionCodes.svelte";
</script>
<svelte:head><title>Connections · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><p class="hail-eyebrow">Better together</p><h1 class="hail-title">Connections</h1><p>Share a code to connect, then talk on your terms.</p></header>
  <div class="mb-6 flex flex-wrap gap-3"><a class="hail-button" href="/compose?audience=connections">New message →</a><a class="hail-button-secondary" href="/?view=connections">View conversations</a></div>
  <ConnectionCodes />
</div>
