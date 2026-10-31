<script lang="ts">
  import {afterNavigate} from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  let {address = "Your account", compact = false, avatar = null}: {address?: string; compact?: boolean; avatar?: string | null} = $props();
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
<button class:compact class="account-trigger" popovertarget={id} aria-label="Open account menu" aria-expanded={open} aria-controls={id}>
  <span class="avatar">{#if avatar && failedAvatar !== avatar}<img bind:this={avatarImage} src={avatar} alt="" />{:else if initials}{initials}{:else}<Icon name="user" />{/if}</span>
  {#if !compact}<span class="account-label"><strong>{address}</strong><small>Personal account</small></span><span class="account-dots" aria-hidden="true">···</span>{/if}
</button>
<div id={id} bind:this={panel} popover="auto" class="account-popover" ontoggle={event => {open = event.newState === "open";}}>
  <div class="menu-heading"><span class="hail-eyebrow">Signed in as</span><strong>{address}</strong></div>
  <nav aria-label="Account menu">
    <a href="/account"><Icon name="user" />Account<Icon name="chevron" size={16} /></a>
    <a href="/settings"><Icon name="settings" />Settings<Icon name="chevron" size={16} /></a>
  </nav>
  <form method="POST" action="/auth/logout" onsubmit={signOut}><button disabled={signingOut}><Icon name="logout" />{signingOut ? "Signing out…" : "Sign out"}</button></form>
  {#if error}<p class="hail-error" role="alert">{error}</p>{/if}
</div>
<style>
  .account-trigger { display:flex; align-items:center; gap:10px; width:100%; padding:12px 8px; border:0; background:transparent; text-align:left; border-radius:14px; }
  .account-trigger:hover, .account-trigger[aria-expanded=true] { background:var(--color-brand-soft); }
  .avatar { display:grid; place-items:center; width:40px; height:40px; flex-shrink:0; border:0; border-radius:50%; background:var(--color-brand-soft); color:var(--color-brand-strong); font-size:13px; font-weight:750; }
  .avatar img { width:100%; height:100%; object-fit:cover; border-radius:50%; }
  .account-label { display:grid; min-width:0; gap:3px; }
  .account-label strong { overflow:hidden; text-overflow:ellipsis; font-size:13px; }
  .account-label small { font-size:11px; color:var(--color-muted); }
  .account-dots { margin-left:auto; font-weight:800; }
  .compact { width:44px; padding:2px; }
  .account-popover { position:fixed; inset:auto auto 96px max(20px, calc((100vw - 1600px) / 2 + 20px)); margin:0; width:286px; max-width:calc(100vw - 32px); padding:8px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); color:var(--color-ink); box-shadow:0 16px 60px #172b2d20; }
  .menu-heading { display:grid; gap:7px; padding:14px 12px 18px; border-bottom:1px solid var(--color-line); }
  .menu-heading .hail-eyebrow { font-size:10px; }
  .menu-heading strong { overflow-wrap:anywhere; font-size:13px; }
  nav { padding:6px 0; }
  nav a, form button { display:flex; width:100%; align-items:center; gap:12px; padding:12px; border:0; border-radius:10px; font-size:13px; font-weight:600; text-decoration:none; background:transparent; }
  nav a :global(svg:last-child) { margin-left:auto; color:var(--color-muted); }
  nav a:hover, form button:hover { background:var(--color-brand-soft); }
  form { border-top:1px solid var(--color-line); padding-top:6px; }
  form button { color:var(--color-danger); }
  @media(max-width:900px) { .account-popover { inset:74px 16px auto auto; } }
</style>
