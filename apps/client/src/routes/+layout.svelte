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
  const navigation = $derived([
    {href: "/?view=subscriptions", label: "Feed", icon: "feed", unread: page.data.unreadCounts?.subscriptions},
    {href: "/?view=connections", label: "Inbox", icon: "chat", unread: page.data.unreadCounts?.connections},
    {href: "/drafts", label: "Drafts", icon: "compose"},
    {href: "/sent", label: "Sent", icon: "sent"},
    {href: "/trash", label: "Trash", icon: "trash"},
    {href: "/permissions", label: "Subscriptions", icon: "people"},
    {href: "/connections", label: "Connections", icon: "user"},
    {href: "/categories", label: "Categories", icon: "feed"}
  ]);
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
  <a href="/" class="brand" aria-label={`${page.data.branding?.name ?? "Hail"} home`}>{#if page.data.branding?.logoPath}<img class="brand-logo w-[36px] h-[36px] object-contain" src={page.data.branding.logoPath} alt="" />{:else}<span class="brand-mark" aria-hidden="true">h</span>{/if}<span>{page.data.branding?.name ?? "Hail"}</span></a>
{/snippet}
{#snippet links()}
  <a class="hail-button compose-button" href="/compose" aria-current={page.url.pathname === "/compose" ? "page" : undefined}>Compose</a>
  <div class="nav-group"><nav aria-label="Main navigation">{#each navigation as item, index}{#if index === 5}<p class="nav-label [margin:22px_14px_6px] text-muted text-[10px] font-[600] tracking-[.1em] uppercase">Your network</p>{/if}<a href={item.href} aria-current={active(item.href) ? "page" : undefined}><Icon name={item.icon} />{item.label}{#if item.unread !== undefined && item.unread > 0}<span class="ml-auto text-right tabular-nums" aria-label={`${item.unread} unread messages`}>{item.unread}</span>{/if}</a>{/each}</nav></div>
  {#if page.data.account?.providerOperator}<a class="hail-button-secondary" href="/admin">Provider administration</a>{/if}
  <div class="nav-bottom"></div>
{/snippet}
<!-- Full navigation prevents signup/recovery CSP from leaking into the app. -->
<div class:focused class:viewing-message={viewingMessage} class="app-shell" data-sveltekit-reload={!page.data.hasAccountSession || page.url.pathname === "/signup" || page.url.pathname === "/signup/recovery"}>
  <a class="skip-link" href="#main-content">Skip to content</a>
  {#if focused}
    <header class="public-header">{@render brand()}{#if page.url.pathname !== "/"}<a class="hail-button-secondary" href="/">{page.data.hasAccountSession ? "Back to home" : "Home"}</a>{:else if page.data.registration?.mode === "invite"}<span class="alpha-badge">Invitation-only alpha</span>{/if}</header>
  {:else}
    <aside class="sidebar">{@render brand()}{@render links()}<div class="sidebar-account [border-top:1px_solid_var(--color-line)] pt-[10px]"><UserMenu {address} {avatar} /></div></aside>
    <header class="mobile-header"><button class="icon-button" onclick={openDrawer} aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="mobile-navigation"><Icon name="menu" /></button>{@render brand()}</header>
    <dialog id="mobile-navigation" class="navigation-drawer" bind:this={drawer} onclose={() => {drawerOpen = false;}} onclick={event => {if (event.target === drawer) closeDrawer();}} aria-label="Navigation">
      <div class="drawer-content"><div class="drawer-heading flex items-center justify-between gap-[10px]">{@render brand()}</div>{@render links()}<div class="drawer-footer"><UserMenu {address} {avatar} compact drawerAccount /><button class="icon-button" onclick={closeDrawer} aria-label="Close navigation"><Icon name="close" /></button></div></div>
    </dialog>
  {/if}
  <main id="main-content" tabindex="-1">{#if page.data.account?.addressReleased}
      <p role="status" class="hail-card p-4">Your former address {page.data.account.address} has been released and may belong to another account. Your inbox, login, and existing conversations still belong to your DID: {page.data.account.did}.</p>
    {/if}
    {@render children()}</main>
</div>
<style lang="postcss">
  @reference "../app.css";

  .app-shell { @apply max-w-[1600px] [margin:0_auto] [padding:20px_20px_20px_256px]; }
  .sidebar {
    @apply fixed [inset:0_auto_0_max(0px,_calc((100vw_-_1600px)_/_2))] w-[236px] flex flex-col gap-[24px]
      [padding:28px_16px_20px] [background:var(--color-canvas)] overflow-y-auto;
  }
  .brand { @apply flex items-center gap-[11px] text-ink [text-decoration:none] text-[26px] font-[750] tracking-[-.055em]; }
  .sidebar > .brand { @apply [padding:0_12px]; }
  .brand-mark {
    @apply grid place-items-center w-[36px] h-[36px] rounded-[11px] [background:var(--color-brand)] text-on-brand
      [font-family:Georgia,serif] text-[29px] italic;
  }
  .compose-button { @apply justify-center min-h-[46px]; }
  nav { @apply grid gap-[3px]; }
  nav a { @apply flex items-center gap-[12px] min-h-[44px] [padding:10px_14px] rounded-[8px] [text-decoration:none] text-[14px] font-[500] text-muted; }
  nav a:hover { @apply [background:var(--color-surface)] text-brand-strong; }
  nav a[aria-current=page] { @apply [background:var(--color-brand-soft)] text-brand-strong font-[650]; }
  .nav-bottom { @apply mt-auto grid gap-[24px]; }
  main { @apply min-w-0 min-h-[calc(100dvh_-_40px)] [padding:28px_clamp(20px,3vw,40px)_48px] rounded-[16px] [background:var(--color-surface)]; }
  .skip-link { @apply fixed top-[8px] left-[8px] z-[20] p-[12px] [background:var(--color-surface)] text-brand-strong [transform:translateY(-150%)]; }
  .skip-link:focus { @apply [transform:none]; }
  .focused { @apply max-w-[1200px] [padding:0_40px]; }
  .public-header { @apply flex justify-between items-center gap-[16px] [padding:30px_0]; }
  .focused main { @apply min-h-0 [padding:32px_0_64px] [background:transparent]; }
  .alpha-badge { @apply [border:1px_solid_var(--color-line)] rounded-[99px] [padding:7px_12px] text-muted text-[11px]; }
  .mobile-header { @apply hidden; }
  .icon-button { @apply grid place-items-center w-[44px] h-[44px] p-0 [border:0] [background:transparent]; }
  .navigation-drawer {
    @apply fixed [inset:0_auto_0_0] w-[min(320px,_calc(100vw_-_40px))] h-[100dvh] [max-height:none] [max-width:none] m-0
      p-0 [border:0];
    @apply [border-right:1px_solid_var(--color-line)] [background:var(--color-canvas)] text-ink;
  }
  .navigation-drawer::backdrop { @apply [background:#172b2d60] [backdrop-filter:blur(3px)]; }
  .drawer-content { @apply min-h-full flex flex-col gap-[28px] [padding:24px_20px_max(24px,_env(safe-area-inset-bottom))]; }
  .drawer-footer { @apply hidden; }
  @media (max-width:900px) {
    .app-shell { @apply [padding:0_16px_calc(88px_+_env(safe-area-inset-bottom))]; }
    .sidebar { @apply hidden; }
    .viewing-message .mobile-header { @apply hidden; }
    .viewing-message main { @apply min-h-[calc(100dvh_-_68px_-_env(safe-area-inset-bottom))]; }
    .viewing-message::after {
      content: "";
      @apply fixed [inset:auto_0_0] h-[calc(68px_+_env(safe-area-inset-bottom))] z-[10] [background:var(--color-canvas)]
        pointer-events-none;
    }
    .mobile-header {
      @apply fixed [inset:auto_0_0] flex z-[10] items-center justify-between min-h-[68px]
        [padding:10px_20px_max(10px,_env(safe-area-inset-bottom))] [border-top:1px_solid_var(--color-line)]
        [background:var(--color-canvas)];
    }
    .mobile-header > .icon-button { @apply ml-auto; }
    .mobile-header > .brand { @apply absolute left-[20px] whitespace-nowrap; }
    .mobile-header .brand { @apply text-[24px]; }
    .mobile-header .brand-mark { @apply w-[34px] h-[34px] rounded-[11px] text-[27px]; }
    main { @apply p-[24px] min-h-[calc(100dvh_-_84px)]; }
    .navigation-drawer {
      @apply [inset:auto_0_0] flex-col w-full h-[82dvh] max-h-[82dvh] [border:0];
      @apply [border-top:1px_solid_var(--color-line)] [border-radius:20px_20px_0_0];
    }
    .navigation-drawer[open] { @apply flex; }
    .drawer-content { @apply flex-1 min-h-0 flex; @apply flex-col gap-[20px] overflow-hidden [padding:24px_20px_max(12px,_env(safe-area-inset-bottom))]; }
    .drawer-content :global(.nav-group) { @apply flex-1 min-h-0 overflow-y-auto overscroll-contain; }
    .navigation-drawer :global(.compose-button) { @apply hidden; }
    .navigation-drawer :global(.nav-bottom) { @apply hidden; }
    .drawer-footer { @apply flex flex-none items-center justify-between mt-auto pt-[12px] [border-top:1px_solid_var(--color-line)]; }
    .drawer-footer :global(.account-trigger) { @apply w-[48px] p-[4px]; }
    .drawer-footer .icon-button { @apply ml-auto; }
  }
  @media (max-width:540px) {
    .app-shell { @apply [padding:0_10px_calc(82px_+_env(safe-area-inset-bottom))]; }
    main { @apply [padding:20px_16px_32px] rounded-[12px]; }
    .focused { @apply [padding:0_20px]; }
    .focused main { @apply pt-[24px]; }
    .public-header { @apply [padding:22px_0]; }
    .alpha-badge { @apply max-w-[120px] text-center text-[10px]; }
    .mobile-header { @apply min-h-[64px] px-[16px]; }
    .mobile-header > .brand { @apply left-[16px]; }
  }
</style>
