import {returnPath} from "$lib/auth-routing.js";

export function load({url}) {
  return {returnTo: returnPath(url.searchParams.get("next"))};
}
