<script lang="ts">
  import {page} from "$app/state";
  import ConnectionCodes from "$lib/ConnectionCodes.svelte";
  let {data}=$props();
</script>
<svelte:head><title>Connections · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<div class="min-w-0">
  <header class="page-heading"><h1 class="hail-title">Connections</h1></header>
  <ConnectionCodes owner={data.account.did} initialList={data.initialList} avatars={data.avatars} />
</div>
