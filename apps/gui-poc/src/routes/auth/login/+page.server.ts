import {env} from "$env/dynamic/private";

export function load(){return {canEnroll:Boolean(env.HAIL_GUI_CREDENTIAL_FILE)};}
