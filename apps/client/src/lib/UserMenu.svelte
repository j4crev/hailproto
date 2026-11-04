<script lang="ts">
  import {afterNavigate} from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  let {address = "Your account", compact = false, avatar = null, drawerAccount = false}: {address?: string; compact?: boolean; avatar?: string | null; drawerAccount?: boolean} = $props();
  let failedAvatar = $state(''), avatarImage = $state<HTMLImageElement>();
  $effect(() => {
    const element=avatarImage, src=avatar;
    if (!element || !src) return;
    const failed=()=>{failedAvatar=src;};
    element.addEventListener('error',failed);
    if(element.complete && !element.naturalWidth)failed();
    return ()=>element.removeEventListener('error',failed);
  });
  const id = $props.id();
  let panel: HTMLDivElement;
  let open = $state(false), signingOut = $state(false), error = $state("");
  async function signOut(event: SubmitEvent) {
    event.preventDefault();
    if (signingOut) return;
    signingOut = true; error = "";
    try {
      // Sensitive pages suppress referrers. A native form there has a null
      // Origin; use the same-origin JSON transport used by other auth controls.
      const response = await fetch("/auth/logout", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
      if (!response.ok) throw new Error();
      location.href = "/";
    } catch {
      error = "Couldn’t sign out. Please try again.";
      signingOut = false;
    }
  }
  const initials = $derived(address === "Your account" ? "" : address.split("@")[0].slice(0, 2).toUpperCase());
  afterNavigate(() => panel?.hidePopover());
</script>
<button class:compact class:drawer-account={drawerAccount} class="account-trigger" popovertarget={id} aria-label="Open account menu" aria-expanded={open} aria-controls={id}>
  <span class="avatar">{#if avatar && failedAvatar !== avatar}<img bind:this={avatarImage} src={avatar} alt="" />{:else if initials}{initials}{:else}<Icon name="user" />{/if}</span>
  {#if !compact}<span class="account-label"><strong>{address}</strong><small>Personal account</small></span><span class="account-dots ml-auto font-[800]" aria-hidden="true">···</span>{/if}
</button>
<div id={id} bind:this={panel} popover="auto" class="account-popover" ontoggle={event => {open = event.newState === "open";}}>
  <div class="menu-heading"><span class="hail-eyebrow">Signed in as</span><strong>{address}</strong></div>
  <nav aria-label="Account menu">
    <a href="/account"><Icon name="user" />Account</a>
    <a href="/settings"><Icon name="settings" />Settings</a>
  </nav>
  <form method="POST" action="/auth/logout" onsubmit={signOut}><button disabled={signingOut}><Icon name="logout" />{signingOut ? "Signing out…" : "Sign out"}</button></form>
  {#if error}<p class="hail-error" role="alert">{error}</p>{/if}
</div>
<style lang="postcss">
  @reference "../app.css";

  .account-trigger { @apply flex items-center gap-[10px] w-full [padding:12px_8px] [border:0] [background:transparent] text-left rounded-[14px]; }
  .account-trigger:hover, .account-trigger[aria-expanded=true] { @apply [background:var(--color-brand-soft)]; }
  .avatar {
    @apply grid place-items-center w-[40px] h-[40px] shrink-0 [border:0] rounded-[50%]
      [background:var(--color-brand-soft)] text-brand-strong text-[13px] font-[750];
  }
  .avatar img { @apply w-full h-full object-cover rounded-[50%]; }
  .account-label { @apply grid min-w-0 gap-[3px]; }
  .account-label strong { @apply overflow-hidden text-ellipsis text-[13px]; }
  .account-label small { @apply text-[11px] text-muted; }
  .compact { @apply w-[44px] p-[2px]; }
  .account-popover {
    @apply fixed [inset:auto_auto_96px_max(20px,_calc((100vw_-_1600px)_/_2_+_20px))] m-0 w-[286px]
      max-w-[calc(100vw_-_32px)] p-[8px] [border:1px_solid_var(--color-line)] rounded-[14px]
      [background:var(--color-surface)] text-ink [box-shadow:0_16px_60px_#172b2d20];
  }
  .menu-heading { @apply grid gap-[7px] [padding:14px_12px_18px] [border-bottom:1px_solid_var(--color-line)]; }
  .menu-heading .hail-eyebrow { @apply text-[10px]; }
  .menu-heading strong { @apply [overflow-wrap:anywhere] text-[13px]; }
  nav { @apply [padding:6px_0]; }
  nav a, form button {
    @apply flex w-full items-center gap-[12px] p-[12px] [border:0] rounded-[10px] text-[13px] font-[600]
      [text-decoration:none] [background:transparent];
  }
  nav a:hover, form button:hover { @apply [background:var(--color-brand-soft)]; }
  form { @apply [border-top:1px_solid_var(--color-line)] pt-[6px]; }
  form button { @apply text-danger; }
  @media (max-width:900px) {
    .account-popover { @apply [inset:74px_16px_auto_auto]; }
    .drawer-account + .account-popover { @apply [inset:auto_auto_calc(82px_+_env(safe-area-inset-bottom))_16px]; }
  }
</style>
