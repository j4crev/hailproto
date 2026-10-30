import { redirect } from "@sveltejs/kit";
// Preserve bookmarked entry points; all signup now lives in the same wizard.
export const load=()=>redirect(303,"/signup");
