import adapter from "@sveltejs/adapter-node";

export default {
  kit: { adapter: adapter(),paths:{relative:false}, csp: {
    mode: "auto",
    directives: {
      "default-src": ["self"], "script-src": ["self"], "style-src": ["self", "unsafe-inline"],
      "img-src": ["self", "data:", "blob:"], "connect-src": ["self"],
      "object-src": ["none"], "base-uri": ["none"], "frame-ancestors": ["none"], "form-action": ["self"],
    },
  } },
};
