FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY --from=build /app/SDK/x_license_python ./SDK/x_license_python
COPY --from=build /app/public/x_license_python.zip ./public/x_license_python.zip
RUN mkdir -p /var/lib/licenx/storage && chown -R node:node /var/lib/licenx /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/server.js"]
