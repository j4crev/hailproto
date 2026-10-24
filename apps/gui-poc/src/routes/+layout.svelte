<script lang="ts">
  import "../app.css";
  import {page} from "$app/state";
  let { children } = $props();
</script>

<svelte:head>
  <title>Hail inbox</title>
  <meta name="description" content="Disposable Hail GUI proof of concept" />
</svelte:head>

<!-- CSP is document-scoped: leave recovery/signup with a full load so their
     no-form/no-network policies cannot leak into the ordinary app via SPA routing. -->
<div class="mx-auto w-[min(860px,calc(100%_-_32px))]" data-sveltekit-reload={page.url.pathname==="/signup"||page.url.pathname==="/signup/recovery"}>
  <header class="flex h-[76px] items-center justify-between max-[540px]:h-auto max-[540px]:min-h-[76px] max-[540px]:flex-wrap max-[540px]:gap-3 max-[540px]:py-3">
    <a href="/" class="flex items-center gap-2.5 text-[19px] font-[750] text-[#123f2b] no-underline" aria-label="Hail inbox home"><span class="grid size-8 place-items-center rounded-[10px] bg-[#17633f] text-white">H</span> Hail</a>
    <nav class="flex gap-4 max-[540px]:flex-wrap max-[540px]:gap-3 [&_a]:text-[13px] [&_a]:font-bold [&_a]:text-[#526058] [&_a]:no-underline"><a href="/">Inbox</a><a href="/sent">Sent</a><a href="/compose">Compose</a><a href="/permissions">Allowed senders</a><a href="/settings/security">Security</a></nav>
  </header>
  <main class="pt-7 pb-16 max-[540px]:pt-3">{@render children()}</main>
</div>
