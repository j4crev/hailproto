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
  const navigation = [
    {href: "/", label: "Inbox", icon: "feed"},
    {href: "/?view=connections", label: "Messages", icon: "chat"},
    {href: "/sent", label: "Sent", icon: "sent"},
    {href: "/trash", label: "Trash", icon: "trash"},
    {href: "/permissions", label: "Subscriptions", icon: "people"},
    {href: "/connections", label: "Connections", icon: "user"},
    {href: "/categories", label: "Categories", icon: "feed"}
  ];
  let focused = $derived(!page.data.hasAccountSession || (page.url.pathname === "/" && page.url.searchParams.has("next")) || page.url.pathname.startsWith("/auth/") || page.url.pathname.startsWith("/signup"));
  let address = $derived(page.data.account?.address ?? "Your account");
  const avatar = $derived(page.data.accountAvatar?.did === page.data.account?.did ? page.data.accountAvatar?.src : null);
  const active = (href: string) => href === "/" || href === "/?view=connections"
    ? (page.url.pathname === "/" || page.url.pathname.startsWith("/message/")) &&
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
  <title>Haili · Your Hail inbox</title>
  <meta name="description" content="Your subscriptions and messages, on your terms. Powered by Hail." />
</svelte:head>
{#snippet brand()}
  <a href="/" class="brand" aria-label="Haili home"><span class="brand-mark" aria-hidden="true">h</span><span>Haili<span class="brand-caption">Powered by Hail</span></span></a>
{/snippet}
{#snippet links()}
  <a class="hail-button compose-button" href="/compose" aria-current={page.url.pathname === "/compose" ? "page" : undefined}><Icon name="plus" />Compose</a>
  <div class="nav-group"><nav aria-label="Main navigation">{#each navigation as item}<a href={item.href} aria-current={active(item.href) ? "page" : undefined}><Icon name={item.icon} />{item.label}{#if active(item.href)}<span class="active-dot" aria-hidden="true"></span>{/if}</a>{/each}</nav></div>
  {#if page.data.account?.providerOperator}<a class="hail-button-secondary" href="/admin">Provider administration</a>{/if}
  <div class="nav-bottom"><span class="alpha-label">Powered by Hail</span></div>
{/snippet}
<!-- Full navigation prevents signup/recovery CSP from leaking into the app. -->
<div class:focused class="app-shell" data-sveltekit-reload={!page.data.hasAccountSession || page.url.pathname === "/signup" || page.url.pathname === "/signup/recovery"}>
  <a class="skip-link" href="#main-content">Skip to content</a>
  {#if focused}
    <header class="public-header">{@render brand()}{#if page.url.pathname !== "/"}<a class="hail-button-secondary" href="/">{page.data.hasAccountSession ? "Back to inbox" : "Home"}</a>{:else if page.data.registration?.mode === "invite"}<span class="alpha-badge">Invitation-only alpha</span>{/if}</header>
  {:else}
    <aside class="sidebar">{@render brand()}{@render links()}<div class="sidebar-account"><UserMenu {address} {avatar} /></div></aside>
    <header class="mobile-header"><button class="icon-button" onclick={openDrawer} aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="mobile-navigation"><Icon name="menu" /></button>{@render brand()}<UserMenu {address} {avatar} compact /></header>
    <dialog id="mobile-navigation" class="navigation-drawer" bind:this={drawer} onclose={() => {drawerOpen = false;}} onclick={event => {if (event.target === drawer) closeDrawer();}} aria-label="Navigation">
      <div class="drawer-content"><div class="drawer-heading">{@render brand()}<button class="icon-button" onclick={closeDrawer} aria-label="Close navigation"><Icon name="close" /></button></div>{@render links()}</div>
    </dialog>
  {/if}
  <main id="main-content" tabindex="-1">{@render children()}</main>
</div>
<style>
  .app-shell { max-width:1600px; margin:0 auto; padding-left:260px; }
  .sidebar { position:fixed; inset:0 auto 0 max(0px, calc((100vw - 1600px) / 2)); width:260px; display:flex; flex-direction:column; gap:30px; padding:36px 20px 14px; border-right:1px solid var(--color-line); background:var(--color-canvas); overflow-y:auto; }
  .brand { display:flex; align-items:center; gap:11px; color:var(--color-ink); text-decoration:none; font-size:28px; font-weight:750; letter-spacing:-.055em; }
  .sidebar > .brand { padding:0 12px; }
  .brand-mark { display:grid; place-items:center; width:42px; height:42px; border-radius:14px; background:var(--color-brand); color:var(--color-on-brand); font-family:Georgia,serif; font-size:32px; font-style:italic; }
  .brand-caption { display:block; font-size:10px; font-weight:500; letter-spacing:.02em; color:var(--color-muted); }
  .compose-button { justify-content:flex-start; padding-left:18px; min-height:48px; box-shadow:0 4px 10px #0f766e15; }
  nav { display:grid; gap:5px; }
  nav a { display:flex; align-items:center; gap:12px; min-height:46px; padding:12px 14px; border-radius:12px; text-decoration:none; font-size:13px; font-weight:600; color:var(--color-muted); }
  nav a:hover { background:var(--color-surface); color:var(--color-brand-strong); }
  nav a[aria-current=page] { background:var(--color-brand-soft); color:var(--color-brand-strong); }
  .active-dot { width:5px; height:5px; border-radius:50%; background:var(--color-brand); margin-left:auto; }
  .nav-bottom { margin-top:auto; display:grid; gap:24px; }
  .alpha-label { padding:0 14px; font-size:10px; color:var(--color-muted); }
  .sidebar-account { border-top:1px solid var(--color-line); padding-top:10px; }
  main { min-width:0; padding:48px clamp(24px,4vw,64px) 80px; }
  .skip-link { position:fixed; top:8px; left:8px; z-index:20; padding:12px; background:var(--color-surface); color:var(--color-brand-strong); transform:translateY(-150%); }
  .skip-link:focus { transform:none; }
  .focused { max-width:1200px; padding:0 40px; }
  .public-header { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:30px 0; }
  .focused main { padding:32px 0 64px; }
  .alpha-badge { border:1px solid var(--color-line); border-radius:99px; padding:7px 12px; color:var(--color-muted); font-size:11px; }
  .mobile-header { display:none; }
  .icon-button { display:grid; place-items:center; width:44px; height:44px; padding:0; border:0; background:transparent; }
  .navigation-drawer { position:fixed; inset:0 auto 0 0; width:min(320px, calc(100vw - 40px)); height:100dvh; max-height:none; max-width:none; margin:0; padding:0; border:0; border-right:1px solid var(--color-line); background:var(--color-canvas); color:var(--color-ink); }
  .navigation-drawer::backdrop { background:#172b2d60; backdrop-filter:blur(3px); }
  .drawer-content { min-height:100%; display:flex; flex-direction:column; gap:28px; padding:24px 20px max(24px, env(safe-area-inset-bottom)); }
  .drawer-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  @media(max-width:900px) {
    .app-shell { padding-left:0; }
    .sidebar { display:none; }
    .mobile-header { display:flex; position:sticky; top:0; z-index:10; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--color-line); background:var(--color-canvas); }
    .mobile-header .brand { font-size:24px; }
    .mobile-header .brand-mark { width:34px; height:34px; border-radius:11px; font-size:27px; }
    .mobile-header .brand-caption { display:none; }
    main { padding:32px 24px 64px; }
  }
  @media(max-width:540px) {
    main { padding:28px 18px 48px; }
    .focused { padding:0 20px; }
    .focused main { padding-top:24px; }
    .public-header { padding:22px 0; }
    .alpha-badge { max-width:120px; text-align:center; font-size:10px; }
  }
</style>
