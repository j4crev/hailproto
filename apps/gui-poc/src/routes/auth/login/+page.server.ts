import {redirect} from "@sveltejs/kit";
import {returnPath} from "$lib/auth-routing.js";

export function load({url}) {
  redirect(303,"/?next=" + encodeURIComponent(returnPath(url.searchParams.get("next"))));
}
