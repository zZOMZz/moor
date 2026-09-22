FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3078 MOOR_PUBLIC_DIR=/app/public MOOR_DATA_DIR=/data
EXPOSE 3078
CMD ["node", "server.mjs"]
