FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
