<script lang="ts">
  let { children } = $props();
</script>

<svelte:head>
  <title>Hail inbox</title>
  <meta name="description" content="Disposable Hail GUI proof of concept" />
</svelte:head>

<div class="shell">
  <header>
    <a href="/" class="brand" aria-label="Hail inbox home"><span>H</span> Hail</a>
    <nav><a href="/">Inbox</a><a href="/sent">Sent</a><a href="/compose">Compose</a><a href="/permissions">Allowed senders</a><a href="/settings/security">Security</a></nav>
  </header>
  <main>{@render children()}</main>
</div>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #f4f6f3; color: #17231d; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  :global(a) { color: inherit; }
  .shell { width: min(860px, calc(100% - 32px)); margin: 0 auto; }
  header { height: 76px; display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 10px; color: #123f2b; font-size: 19px; font-weight: 750; text-decoration: none; }
  .brand span { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 10px; background: #17633f; color: white; }
  nav { display: flex; gap: 16px; } nav a { color: #526058; font-size: 13px; font-weight: 700; text-decoration: none; }
  main { padding: 28px 0 64px; }
  :global(.card) { background: white; border: 1px solid #dfe5e0; border-radius: 18px; box-shadow: 0 10px 30px rgba(21, 50, 35, .05); }
  @media (max-width: 540px) { main { padding-top: 12px; } header{height:auto;min-height:76px;flex-wrap:wrap;gap:12px;padding:12px 0}nav{flex-wrap:wrap;gap:12px} }
</style>
