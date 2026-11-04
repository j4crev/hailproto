<script lang="ts">
  import "../app.css";
  import {onMount} from "svelte";
  import {initializeThemePreference, syncAccountPreferences, clearPreferenceAccount} from "$lib/preferences.js";
  onMount(() => {
    const cleanup = initializeThemePreference();
    const refresh = () => {
      const did = page.data.account?.did;
      if (did) void syncAccountPreferences(did).catch(() => {});
      else clearPreferenceAccount();
    };
    window.addEventListener("focus", refresh);
    return () => {cleanup(); window.removeEventListener("focus", refresh);};
  });
  import {page} from "$app/state";
  import {afterNavigate} from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import UserMenu from "$lib/UserMenu.svelte";
  let {children} = $props();
  let drawer = $state<HTMLDialogElement>();
  let drawerOpen = $state(false);
  let viewingMessage = $derived(page.route.id === '/message/[sender]/[messageId]' || page.route.id === '/conversation/[sender]/[messageId]' || page.route.id === '/sent/[messageId]' || page.route.id === '/sent/send/[kind]/[messageId]');
  const navigation = [
    {href: "/?view=subscriptions", label: "Feed", icon: "feed"},
    {href: "/?view=connections", label: "Inbox", icon: "chat"},
    {href: "/drafts", label: "Drafts", icon: "compose"},
    {href: "/sent", label: "Sent", icon: "sent"},
    {href: "/trash", label: "Trash", icon: "trash"},
    {href: "/permissions", label: "Subscriptions", icon: "people"},
    {href: "/connections", label: "Connections", icon: "user"},
    {href: "/categories", label: "Categories", icon: "feed"}
  ];
  let focused = $derived(!page.data.hasAccountSession || (page.url.pathname === "/" && page.url.searchParams.has("next")) || page.url.pathname.startsWith("/auth/") || page.url.pathname.startsWith("/signup"));
  let address = $derived(page.data.account?.address ?? "Your account");
  const avatar = $derived(page.data.accountAvatar?.did === page.data.account?.did ? page.data.accountAvatar?.src : null);
  const active = (href: string) => href === "/?view=subscriptions" || href === "/?view=connections"
    ? page.url.pathname.startsWith("/conversation/") ? href === "/?view=connections" : (page.url.pathname === "/" || page.url.pathname.startsWith("/message/")) &&
      (page.url.searchParams.get("view") === "connections") === (href === "/?view=connections")
    : page.url.pathname === href || page.url.pathname.startsWith(href + "/");
  function closeDrawer() { drawer?.close(); drawerOpen = false; }
  function openDrawer() { drawer?.showModal(); drawerOpen = true; }
  afterNavigate(() => {
    closeDrawer();
    const did = page.data.account?.did;
    if (did) void syncAccountPreferences(did).catch(() => {});
    else clearPreferenceAccount();
  });
  $effect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const desktop = matchMedia("(min-width: 901px)");
    const resized = () => { if (desktop.matches) closeDrawer(); };
    desktop.addEventListener("change", resized);
    return () => { document.body.style.overflow = previous; desktop.removeEventListener("change", resized); };
  });
</script>
<svelte:head>
  <link rel="icon" href={page.data.branding?.faviconPath ?? "/favicon.svg"} />
  <title>{page.data.branding?.name ?? "Hail"} · Your Hail inbox</title>
  <meta name="description" content="Your subscriptions and messages, on your terms. Powered by Hail." />
</svelte:head>
{#snippet brand()}
  <a href="/" class="brand" aria-label={`${page.data.branding?.name ?? "Hail"} home`}>{#if page.data.branding?.logoPath}<img class="brand-logo" src={page.data.branding.logoPath} alt="" />{:else}<span class="brand-mark" aria-hidden="true">h</span>{/if}<span>{page.data.branding?.name ?? "Hail"}</span></a>
{/snippet}
{#snippet links()}
  <a class="hail-button compose-button" href="/compose" aria-current={page.url.pathname === "/compose" ? "page" : undefined}>Compose</a>
  <div class="nav-group"><nav aria-label="Main navigation">{#each navigation as item, index}{#if index === 5}<p class="nav-label">Your network</p>{/if}<a href={item.href} aria-current={active(item.href) ? "page" : undefined}><Icon name={item.icon} />{item.label}</a>{/each}</nav></div>
  {#if page.data.account?.providerOperator}<a class="hail-button-secondary" href="/admin">Provider administration</a>{/if}
  <div class="nav-bottom"></div>
{/snippet}
<!-- Full navigation prevents signup/recovery CSP from leaking into the app. -->
<div class:focused class:viewing-message={viewingMessage} class="app-shell" data-sveltekit-reload={!page.data.hasAccountSession || page.url.pathname === "/signup" || page.url.pathname === "/signup/recovery"}>
  <a class="skip-link" href="#main-content">Skip to content</a>
  {#if focused}
    <header class="public-header">{@render brand()}{#if page.url.pathname !== "/"}<a class="hail-button-secondary" href="/">{page.data.hasAccountSession ? "Back to home" : "Home"}</a>{:else if page.data.registration?.mode === "invite"}<span class="alpha-badge">Invitation-only alpha</span>{/if}</header>
  {:else}
    <aside class="sidebar">{@render brand()}{@render links()}<div class="sidebar-account"><UserMenu {address} {avatar} /></div></aside>
    <header class="mobile-header"><button class="icon-button" onclick={openDrawer} aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="mobile-navigation"><Icon name="menu" /></button>{@render brand()}</header>
    <dialog id="mobile-navigation" class="navigation-drawer" bind:this={drawer} onclose={() => {drawerOpen = false;}} onclick={event => {if (event.target === drawer) closeDrawer();}} aria-label="Navigation">
      <div class="drawer-content"><div class="drawer-heading">{@render brand()}</div>{@render links()}<div class="drawer-footer"><UserMenu {address} {avatar} compact drawerAccount /><button class="icon-button" onclick={closeDrawer} aria-label="Close navigation"><Icon name="close" /></button></div></div>
    </dialog>
  {/if}
  <main id="main-content" tabindex="-1">{#if page.data.account?.addressReleased}
      <p role="status" class="hail-card p-4">Your former address {page.data.account.address} has been released and may belong to another account. Your inbox, login, and existing conversations still belong to your DID: {page.data.account.did}.</p>
    {/if}
    {@render children()}</main>
</div>
<style>
  .app-shell { max-width:1600px; margin:0 auto; padding:20px 20px 20px 256px; }
  .sidebar { position:fixed; inset:0 auto 0 max(0px, calc((100vw - 1600px) / 2)); width:236px; display:flex; flex-direction:column; gap:24px; padding:28px 16px 20px; background:var(--color-canvas); overflow-y:auto; }
  .brand { display:flex; align-items:center; gap:11px; color:var(--color-ink); text-decoration:none; font-size:26px; font-weight:750; letter-spacing:-.055em; }
  .sidebar > .brand { padding:0 12px; }
  .brand-logo { width:36px; height:36px; object-fit:contain; }
  .brand-mark { display:grid; place-items:center; width:36px; height:36px; border-radius:11px; background:var(--color-brand); color:var(--color-on-brand); font-family:Georgia,serif; font-size:29px; font-style:italic; }
  .compose-button { justify-content:flex-start; padding-left:18px; min-height:46px; }
  nav { display:grid; gap:3px; }
  .nav-label { margin:22px 14px 6px; color:var(--color-muted); font-size:10px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; }
  nav a { display:flex; align-items:center; gap:12px; min-height:44px; padding:10px 14px; border-radius:8px; text-decoration:none; font-size:14px; font-weight:500; color:var(--color-muted); }
  nav a:hover { background:var(--color-surface); color:var(--color-brand-strong); }
  nav a[aria-current=page] { background:var(--color-brand-soft); color:var(--color-brand-strong); font-weight:650; }
  .nav-bottom { margin-top:auto; display:grid; gap:24px; }
  .sidebar-account { border-top:1px solid var(--color-line); padding-top:10px; }
  main { min-width:0; min-height:calc(100dvh - 40px); padding:28px clamp(20px,3vw,40px) 48px; border-radius:16px; background:var(--color-surface); }
  .skip-link { position:fixed; top:8px; left:8px; z-index:20; padding:12px; background:var(--color-surface); color:var(--color-brand-strong); transform:translateY(-150%); }
  .skip-link:focus { transform:none; }
  .focused { max-width:1200px; padding:0 40px; }
  .public-header { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:30px 0; }
  .focused main { min-height:0; padding:32px 0 64px; background:transparent; }
  .alpha-badge { border:1px solid var(--color-line); border-radius:99px; padding:7px 12px; color:var(--color-muted); font-size:11px; }
  .mobile-header { display:none; }
  .icon-button { display:grid; place-items:center; width:44px; height:44px; padding:0; border:0; background:transparent; }
  .navigation-drawer { position:fixed; inset:0 auto 0 0; width:min(320px, calc(100vw - 40px)); height:100dvh; max-height:none; max-width:none; margin:0; padding:0; border:0; border-right:1px solid var(--color-line); background:var(--color-canvas); color:var(--color-ink); }
  .navigation-drawer::backdrop { background:#172b2d60; backdrop-filter:blur(3px); }
  .drawer-content { min-height:100%; display:flex; flex-direction:column; gap:28px; padding:24px 20px max(24px, env(safe-area-inset-bottom)); }
  .drawer-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .drawer-footer { display:none; }
  @media(max-width:900px) {
    .app-shell { padding:0 16px calc(88px + env(safe-area-inset-bottom)); }
    .sidebar { display:none; }
    .viewing-message .mobile-header { display:none; }
    .viewing-message main { min-height:calc(100dvh - 68px - env(safe-area-inset-bottom)); }
    .viewing-message::after { content:""; position:fixed; inset:auto 0 0; height:calc(68px + env(safe-area-inset-bottom)); z-index:10; background:var(--color-canvas); pointer-events:none; }
    .mobile-header { position:fixed; inset:auto 0 0; display:flex; z-index:10; align-items:center; justify-content:space-between; min-height:68px; padding:10px 20px max(10px, env(safe-area-inset-bottom)); border-top:1px solid var(--color-line); background:var(--color-canvas); }
    .mobile-header > .icon-button { margin-left:auto; }
    .mobile-header > .brand { position:absolute; left:20px; white-space:nowrap; }
    .mobile-header .brand { font-size:24px; }
    .mobile-header .brand-mark { width:34px; height:34px; border-radius:11px; font-size:27px; }
    main { padding:24px; min-height:calc(100dvh - 84px); }
    .navigation-drawer { inset:auto 0 0; flex-direction:column; width:100%; height:82dvh; max-height:82dvh; border:0; border-top:1px solid var(--color-line); border-radius:20px 20px 0 0; }
    .navigation-drawer[open] { display:flex; }
    .drawer-content { flex:1; min-height:0; display:flex; flex-direction:column; gap:20px; overflow:hidden; padding:24px 20px max(12px, env(safe-area-inset-bottom)); }
    .drawer-content :global(.nav-group) { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
    .navigation-drawer :global(.compose-button) { display:none; }
    .navigation-drawer :global(.nav-bottom) { display:none; }
    .drawer-footer { display:flex; flex:none; align-items:center; justify-content:space-between; margin-top:auto; padding-top:12px; border-top:1px solid var(--color-line); }
    .drawer-footer :global(.account-trigger) { width:48px; padding:2px; }
    .drawer-footer .icon-button { margin-left:auto; }
  }
  @media(max-width:540px) {
    .app-shell { padding:0 10px calc(82px + env(safe-area-inset-bottom)); }
    main { padding:20px 16px 32px; border-radius:12px; }
    .focused { padding:0 20px; }
    .focused main { padding-top:24px; }
    .public-header { padding:22px 0; }
    .alpha-badge { max-width:120px; text-align:center; font-size:10px; }
    .mobile-header { min-height:64px; padding-inline:16px; }
    .mobile-header > .brand { left:16px; }
  }
</style>
