FROM node:20-alpine
WORKDIR /app
# Prisma engine needs libssl — Alpine 3.20+ ships 3.x, install it explicitly
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
# Copy YAML spec to dist/ so it's loadable at runtime
RUN cp src/openapi.yaml dist/openapi.yaml
EXPOSE 3000
CMD ["npm", "start"]
