FROM node:24-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=8787
ENV NODE_ENV=production

COPY backend ./backend

EXPOSE 8787

CMD ["node", "backend/server.js"]
