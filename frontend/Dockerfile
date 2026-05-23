FROM node:24-alpine

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=80

COPY frontend ./frontend

EXPOSE 80

CMD ["node", "frontend/dev-server.js"]
