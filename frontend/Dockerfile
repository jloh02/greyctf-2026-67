FROM node:24-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=4173

COPY frontend ./frontend

EXPOSE 4173

CMD ["node", "frontend/dev-server.js"]
