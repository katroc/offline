FROM node:20-slim

# Install curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy built server
COPY packages/mcp-server/dist ./dist
COPY packages/mcp-server/package.json ./package.json

# Install only production dependencies (this creates the symlink)
RUN npm install --omit=dev

# Replace the symlink with actual files
RUN rm -f node_modules/@app/shared
COPY packages/shared ./node_modules/@app/shared

# Expose port
EXPOSE 8787

# Start the server
CMD ["node", "dist/main.js"]