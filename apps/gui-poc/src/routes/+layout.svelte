<script lang="ts">
  import "../app.css";
  import {page} from "$app/state";
  let { children } = $props();
  const navigation = [
    {href: "/", label: "Feed", path: "M4 5h16v14H4z M4 9h16 M8 13h8 M8 16h5"},
    {href: "/?view=connections", label: "Conversations", path: "M4 4h16v12H9l-5 4z M8 8h8 M8 12h5"},
    {href: "/sent", label: "Sent", path: "m3 11 18-8-8 18-3-8-7-2Z M10 13 21 3"},
    {href: "/permissions", label: "Allowed senders", path: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 8l2 2 3-3"},
    {href: "/settings/security", label: "Security", path: "m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z m-4 9 3 3 5-5"}
  ];
  let focused = $derived(!page.data.hasAccountSession || page.url.pathname.startsWith("/auth/") || page.url.pathname.startsWith("/signup"));
  const active = (href: string) => href === "/?view=connections"?(page.url.pathname==="/"||page.url.pathname.startsWith("/message/"))&&page.url.searchParams.get("view")==="connections":href === "/"
    ? (page.url.pathname === "/" || page.url.pathname.startsWith("/message/"))&&page.url.searchParams.get("view")!=="connections"
    : page.url.pathname === href || page.url.pathname.startsWith(href + "/");
</script>

<svelte:head>
  <title>Haili · Your Hail inbox</title>
  <meta name="description" content="Your subscriptions and correspondence, on your terms. Powered by Hail." />
</svelte:head>

<!-- CSP is document-scoped: leave recovery/signup with a full load so their
     no-form/no-network policies cannot leak into the ordinary app via SPA routing.
     Signed-out links also use document navigation to retain fragments at login. -->
<div class:focused class="app-shell" data-sveltekit-reload={!page.data.hasAccountSession||page.url.pathname==="/signup"||page.url.pathname==="/signup/recovery"}>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="sidebar">
    <a href="/" class="brand" aria-label="Haili home"><span class="brand-mark" aria-hidden="true">h</span><span>Haili<span class="brand-caption">Powered by Hail</span></span></a>
    {#if focused}
      {#if page.url.pathname!=="/"}<a class="hail-button-secondary" href="/">{page.data.hasAccountSession?"Back to inbox":"Home"}</a>{:else}<span class="text-xs font-semibold text-muted">Invitation-only alpha</span>{/if}
    {:else}
      <a class="hail-button" href="/compose" aria-current={page.url.pathname==="/compose"?"page":undefined}><span aria-hidden="true">＋</span> Compose</a>
      <nav aria-label="Main navigation">
        {#each navigation as item}
          <a href={item.href} aria-current={active(item.href)?"page":undefined}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={item.path} /></svg>
            {item.label}
          </a>
        {/each}
      </nav>
      <div class="sidebar-note"><strong>Your inbox. Your permission.</strong><p>Choose who can reach you, and what they can send.</p><span>Invitation-only alpha</span></div>
    {/if}
  </header>
  <main id="main-content" tabindex="-1">{@render children()}</main>
</div>

<style>
  .app-shell { max-width: 1500px; margin: 0 auto; padding-left: 248px; }
  .sidebar { position: fixed; inset: 0 auto 0 max(0px, calc((100vw - 1500px) / 2)); width: 248px; padding: 36px 24px; display: flex; flex-direction: column; gap: 28px; overflow-y: auto; border-right: 1px solid var(--color-line); background: var(--color-canvas); }
  .brand { display: flex; align-items: center; gap: 12px; color: var(--color-ink); text-decoration: none; font-size: 27px; font-weight: 750; letter-spacing: -.04em; }
  .brand-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px; background: var(--color-brand); color: white; font-family: Georgia, serif; font-size: 32px; font-style: italic; }
  .brand-caption { display: block; font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--color-muted); }
  nav { display: grid; gap: 6px; }
  nav a { display: flex; align-items: center; gap: 12px; min-height: 46px; padding: 10px 12px; border-radius: 12px; text-decoration: none; font-size: 14px; font-weight: 600; color: var(--color-muted); }
  nav a:hover { background: var(--color-surface); color: var(--color-brand-strong); }
  nav a[aria-current=page] { background: var(--color-brand-soft); color: var(--color-brand-strong); }
  .sidebar-note { margin-top: auto; font-size: 12px; color: var(--color-muted); }
  .sidebar-note strong { color: var(--color-ink); }
  .sidebar-note p { margin: 8px 0 20px; }
  .sidebar-note span { font-size: 11px; border: 1px solid var(--color-line); border-radius: 99px; padding: 5px 9px; }
  main { min-width: 0; padding: 48px clamp(24px, 4vw, 64px) 80px; }
  .skip-link { position: fixed; top: 8px; left: 8px; z-index: 20; padding: 12px; background: var(--color-surface); color: var(--color-brand-strong); transform: translateY(-150%); }
  .skip-link:focus { transform: none; }
  .focused { max-width: 860px; padding: 0 24px; }
  .focused .sidebar { position: static; width: auto; padding: 24px 0; flex-direction: row; align-items: center; justify-content: space-between; border: 0; }
  .focused main { padding: 16px 0 64px; }
  @media (max-width: 900px) {
    .app-shell { padding-left: 0; }
    .sidebar { position: static; width: auto; padding: 20px 24px 12px; flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 18px; border-right: 0; border-bottom: 1px solid var(--color-line); }
    nav { display: flex; flex-wrap: wrap; width: 100%; gap: 4px; overflow-x: auto; padding: 4px; }
    nav a { flex-shrink: 0; padding: 10px; font-size: 13px; gap: 7px; }
    .sidebar-note { display: none; }
    main { padding: 28px 24px 64px; }
  }
  @media (max-width: 540px) {
    .sidebar { padding: 16px 16px 8px; }
    .brand { font-size: 24px; }
    nav a { font-size: 12px; }
    nav svg { display: none; }
    main { padding: 24px 16px 48px; }
    .focused { padding: 0 16px; }
    .focused .sidebar { padding: 20px 0; }
  }
</style>
