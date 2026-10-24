import {isConfigured} from "$lib/server/canary.js";

export function load({cookies}) {
  // Presentation hint only. Account loaders still validate the provider session.
  return {hasAccountSession: isConfigured(cookies)};
}
