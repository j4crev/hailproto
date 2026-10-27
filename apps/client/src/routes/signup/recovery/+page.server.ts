import { env } from "$env/dynamic/private";
import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ setHeaders }) => {
  if (env.HAIL_GUI_SIGNUP_PREVIEW !== "true") error(404, "Not found");
  setHeaders({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
  return {};
};
