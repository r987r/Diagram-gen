# ═══════════════════════════════════════════════════════════════════
# Single-stage build — all assets (including vendored Three.js) are
# checked into the repository, so no internet access is required
# during the Docker build or at runtime.
# ═══════════════════════════════════════════════════════════════════
FROM nginx:alpine

# Remove the nginx default page
RUN rm -rf /usr/share/nginx/html/*

# Viewer HTML / JS / CSS
COPY viewer/ /usr/share/nginx/html/

# Design metadata (JSON)
COPY metadata/ /usr/share/nginx/html/metadata/

# Pre-vendored Three.js r0.160.0 (checked into vendor/) — served at /vendor/
# The importmap in index.html resolves "three" and "three/addons/" to these paths.
COPY vendor/ /usr/share/nginx/html/vendor/

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
