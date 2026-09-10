FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . /app
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3078 MOOR_PUBLIC_DIR=/app/public MOOR_DATA_DIR=/data
EXPOSE 3078
CMD ["node", "server.mjs"]
