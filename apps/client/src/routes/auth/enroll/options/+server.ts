import {error} from "@sveltejs/kit";

export async function POST(){
  error(403,"Use owner-authorized enrollment at /auth/recover");
}
