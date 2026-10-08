FROM node:22-alpine
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install
COPY backend .
ENV DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/yarus?schema=public
RUN npx prisma generate
EXPOSE 3001
CMD ["sh", "-c", "npx prisma db push && npx tsx src/seed.ts && npx tsx src/main.ts"]
