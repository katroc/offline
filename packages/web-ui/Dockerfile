FROM node:20-slim

# Install serve to serve the built files
RUN npm install -g serve

# Copy built files
COPY packages/web-ui/dist /app/dist

# Expose port
EXPOSE 3000

# Serve the built files
CMD ["serve", "-s", "/app/dist", "-l", "3000"]